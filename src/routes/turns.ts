/** Turns: prompt, command, shell, abort, compact, and small-model generation. */
import { randomUUID } from "node:crypto";
import { abortSession, compactSession, promptSession, runShell } from "../sessions/service";
import { mimeFromPath } from "../sessions/prompt-input";
import { generateSmallModelText } from "../adapters/openchamber/small-model";
import { toV2FileAttachment } from "../adapters/openchamber/v2";
import { splitProviderPrefix } from "../providers/registry";
import { emitOpenCodeV2Event } from "../shared/sse";
import { logger } from "../shared/logger";
import type { RouteContext } from "../http/router";
import { asRecord, readJson } from "../http/response";
import { commitStagedRevert, refuseIfOpenElsewhere, resolveSessionRoute } from "../services/session-route";

function generationStatus(err: unknown): number {
  const status = (err as { statusCode?: unknown })?.statusCode;
  return typeof status === "number" ? status : 500;
}

export async function handleTurns(ctx: RouteContext): Promise<Response | undefined> {
  const { req, path, p, dir, effectiveDir, json, jsonError, noContent } = ctx;
  // Session summarize / compact
  const compactMatch = p.match(/^(?:\/api)?\/session\/([^/]+)\/(?:summarize|compact)$/);
  if (compactMatch && req.method === "POST") {
    try {
      const { backend, session } = await resolveSessionRoute(compactMatch[1], dir);
      if (!session) return jsonError("session not found", 404);
      if (!backend.capabilities.compact) return jsonError("summarize not supported by backend", 501);
      try {
        await compactSession(session);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "summarize failed", 409);
      }
      const body = asRecord(await readJson(req));
      const message = {
        id: typeof body?.id === "string" ? body.id : randomUUID(),
        sessionID: session.id,
        time: { created: Date.now() },
        type: "compaction",
        payload: {},
        delivery: body?.delivery === "steer" ? "steer" : "queue",
      };
      return json({ data: message });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "summarize failed", 500);
    }
  }

  // Session command
  const cmdMatch = p.match(/^\/session\/([^/]+)\/command$/);
  if (cmdMatch && req.method === "POST") {
    try {
      const openCodeId = cmdMatch[1];
      const body = asRecord(await readJson(req));
      const { session } = await resolveSessionRoute(openCodeId, dir);
      if (!session) return jsonError("session not found", 404);
      const command = typeof body?.name === "string" ? body.name : typeof body?.command === "string" ? body.command : "";
      const argumentsText = typeof body?.text === "string" ? body.text : typeof body?.arguments === "string" ? body.arguments : "";
      const commandText = `/${command}${argumentsText ? ` ${argumentsText}` : ""}`.trim();
      const held = await refuseIfOpenElsewhere(openCodeId, session);
      if (held) return json({ _tag: "InvalidRequestError", message: held, error: held }, { status: 400 });
      const result = await promptSession(session, {
        text: commandText,
        ...(typeof body?.id === "string" ? { id: body.id } : {}),
        ...(Array.isArray(body?.files) ? { files: body.files } : {}),
        ...(Array.isArray(body?.agents) ? { agents: body.agents } : {}),
        ...(Array.isArray(body?.skills) ? { skills: body.skills } : {}),
        ...(body?.delivery === "steer" || body?.delivery === "queue" ? { delivery: body.delivery } : {}),
      });
      if (result.queued) return noContent();
      return jsonError(result.error ?? "command failed", result.status ?? 400);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "command failed", 500);
    }
  }

  // Session shell
  const shellMatch = p.match(/^\/session\/([^/]+)\/shell$/);
  if (shellMatch && req.method === "POST") {
    try {
      const openCodeId = shellMatch[1];
      const { backend, session } = await resolveSessionRoute(openCodeId, dir);
      if (!session) return jsonError("session not found", 404);
      if (!backend.capabilities.shell) return jsonError("shell not supported by backend", 400);
      const body = asRecord(await readJson(req));
      const command = typeof body?.command === "string" ? body.command : "";
      const shellID = typeof body?.id === "string" && body.id ? body.id : randomUUID();
      const started = Date.now();
      const shell = {
        id: shellID,
        status: "running" as const,
        command,
        cwd: session.directory,
        shell: "bash",
        file: "/bin/bash",
        metadata: {},
        time: { started },
      };
      emitOpenCodeV2Event("session.shell.started", { sessionID: openCodeId, shell }, session.directory);
      let rawOutput: unknown;
      try {
        rawOutput = await runShell(session, command);
      } catch (err) {
        rawOutput = String(err);
      }
      const outputRecord = asRecord(rawOutput) ?? {};
      const outputText = typeof rawOutput === "string"
        ? rawOutput
        : typeof outputRecord.output === "string"
          ? outputRecord.output
          : rawOutput == null ? "" : JSON.stringify(rawOutput);
      const exit = typeof outputRecord.exitCode === "number"
        ? outputRecord.exitCode
        : typeof outputRecord.exit === "number" ? outputRecord.exit : undefined;
      const completed = Date.now();
      const endedShell = {
        ...shell,
        status: "exited" as const,
        ...(exit !== undefined ? { exit } : {}),
        time: { started, completed },
      };
      emitOpenCodeV2Event("session.shell.ended", {
        sessionID: openCodeId,
        shell: endedShell,
        output: { output: outputText, cursor: outputText.length, size: outputText.length, truncated: false },
      }, session.directory);
      logger.debug({ sessionID: openCodeId, output: outputText.slice(0, 200) }, "shell command completed");
      return noContent();
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "shell failed", 500);
    }
  }

  const sessionGenerateMatch = p.match(/^\/session\/([^/]+)\/generate$/);
  if (sessionGenerateMatch && req.method === "POST") {
    try {
      const sessionID = decodeURIComponent(sessionGenerateMatch[1]!);
      const { backend, session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const body = asRecord(await readJson(req));
      if (typeof body?.prompt !== "string" || !body.prompt.trim()) return jsonError("prompt required", 400);
      const messages = await backend.store.transcript(sessionID, session.directory);
      const history = (messages ?? []).slice(-20).map((message) => {
        const role = message.info.role === "user" ? "User" : message.info.role === "assistant" ? "Assistant" : "";
        if (!role) return "";
        const content = (message.parts ?? []).filter((part) => part.type === "text" || part.type === "reasoning")
          .map((part) => (part as { text?: string }).text).join("\n").trim();
        return content ? `${role}: ${content}` : "";
      }).filter(Boolean).join("\n\n").slice(-48_000);
      const prompt = [history ? `Conversation context:\n${history}` : "", body.prompt].filter(Boolean).join("\n\n");
      let generated;
      try {
        generated = await generateSmallModelText({
          prompt,
          maxOutputTokens: 1200,
          preferredProviderID: session.model.providerID,
          preferredModelID: session.model.modelID,
          directory: session.directory,
        });
      } catch {
        generated = await generateSmallModelText({ prompt, maxOutputTokens: 1200, directory: session.directory });
      }
      return json({ data: { text: generated.text } });
    } catch (err) {
      const status = generationStatus(err);
      return jsonError(err instanceof Error ? err.message : "session generation failed", status);
    }
  }

  // `/experimental/generate/text` is what OpenChamber's own small-model
  // service (goal progress checks, titles, commit text) calls on its backend.
  // The named model runs exactly as asked, through omp.
  if ((p === "/generate/text" || p === "/experimental/generate/text") && req.method === "POST") {
    try {
      const body = asRecord(await readJson(req));
      if (typeof body?.prompt !== "string" || !body.prompt.trim()) return jsonError("prompt required", 400);
      const model = asRecord(body.model);
      const selection = splitProviderPrefix(typeof model?.providerID === "string" ? model.providerID : "");
      const modelId = typeof model?.id === "string" ? model.id : undefined;
      const generated = await generateSmallModelText({
        prompt: body.prompt,
        directory: dir ?? process.cwd(),
        ...(selection.native && modelId ? { model: `${selection.native}/${modelId}` } : {}),
        ...(typeof model?.variant === "string" ? { variant: model.variant } : {}),
      });
      return json({ data: { text: generated.text }, text: generated.text });
    } catch (err) {
      const status = generationStatus(err);
      return jsonError(err instanceof Error ? err.message : "text generation failed", status);
    }
  }

  // `/session/:id/prompt`, `/prompt_async` and the legacy `POST /session/:id/message`
  // are one prompt: they differ only in what the acknowledgement looks like.
  const promptMatch = p.match(/^\/session\/([^/]+)\/(prompt|prompt_async|message)$/);
  if (promptMatch && req.method === "POST") {
    try {
      const sessionID = decodeURIComponent(promptMatch[1]!);
      const body = await readJson(req);
      const input = asRecord(body);
      const { backend, session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const held = await refuseIfOpenElsewhere(sessionID, session);
      if (held) return json({ _tag: "InvalidRequestError", message: held, error: held }, { status: 400 });
      await commitStagedRevert(sessionID, backend, session);
      const result = await promptSession(session, body);
      if (!result.queued) return jsonError(result.error ?? "prompt failed", result.status ?? 400);
      if (promptMatch[2] !== "prompt") return json({ queued: true });
      const files = Array.isArray(input?.files) ? (input?.files as unknown[]).flatMap((entry) => {
        const file = asRecord(entry);
        if (typeof file?.uri !== "string") return [];
        return [toV2FileAttachment({
          uri: file.uri,
          mime: mimeFromPath(typeof file.name === "string" ? file.name : file.uri) ?? undefined,
          ...(typeof file.name === "string" ? { name: file.name } : {}),
          ...(typeof file.description === "string" ? { description: file.description } : {}),
          ...(asRecord(file.mention) ? { mention: file.mention as { start: number; end: number; text: string } } : {}),
        })];
      }) : [];
      const delivery = input?.delivery === "steer" ? "steer" : "queue";
      const message = {
        id: result.messageID ?? (typeof input?.id === "string" ? input.id : randomUUID()),
        sessionID,
        time: { created: Date.now() },
        type: "user",
        payload: {
          text: typeof input?.text === "string" ? input.text : "",
          ...(files.length ? { files } : {}),
          ...(Array.isArray(input?.agents) ? { agents: input.agents } : {}),
          ...(Array.isArray(input?.skills) ? { skills: input.skills } : {}),
          ...(asRecord(input?.metadata) ? { metadata: input?.metadata } : {}),
        },
        delivery,
      };
      return json({ data: message });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "prompt failed", 500);
    }
  }

  // `/interrupt` answers `{ interrupted }`; the legacy `/abort` answers a bare boolean.
  const stopMatch = p.match(/^\/session\/([^/]+)\/(interrupt|abort)$/);
  if (stopMatch && req.method === "POST") {
    try {
      const sessionID = decodeURIComponent(stopMatch[1]!);
      const { session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return stopMatch[2] === "interrupt" ? json({ interrupted: false }) : json(false);
      const { stopped, withdrawn } = await abortSession(session);
      // `withdrawn`: queued input Esc took back from omp (D3), returned unsent.
      return stopMatch[2] === "interrupt"
        ? json({ interrupted: stopped, ...(withdrawn ? { withdrawn: { steering: withdrawn.steering, followUp: withdrawn.followUp } } : {}) })
        : json(stopped);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : `${stopMatch[2]} failed`, 500);
    }
  }

  if (path === "/api/small-model/generate") {
    if (req.method !== "POST") return jsonError("method not allowed", 405);
    const body = (await readJson(req)) as Record<string, unknown> | undefined;
    const {
      prompt,
      system,
      maxOutputTokens,
      model,
      directory,
      preferredProviderID,
      preferredModelID,
    } = body || {};

    try {
      const result = await generateSmallModelText({
        prompt: typeof prompt === "string" ? prompt : "",
        system: typeof system === "string" ? system : undefined,
        maxOutputTokens: typeof maxOutputTokens === "number" ? maxOutputTokens : undefined,
        model: typeof model === "string" ? model : undefined,
        directory: typeof directory === "string" ? directory : effectiveDir,
        preferredProviderID: typeof preferredProviderID === "string" ? preferredProviderID : undefined,
        preferredModelID: typeof preferredModelID === "string" ? preferredModelID : undefined,
      });
      return json(result);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode || 500;
      const msg = err instanceof Error ? err.message : "Small model generation failed";
      if (statusCode >= 500) {
        logger.error({ err, path }, `[small-model] generation failed: ${msg}`);
      }
      return jsonError(msg, statusCode);
    }
  }

  return undefined;
}
