/** Session lifecycle: create, list, get, update, delete, fork, status, view/move/model/agent. */
import {
  addSessionSyntheticContext,
  applyGoalChange,
  applySessionModel,
  getSessionStatusMap,
  reconcileSessionStatuses,
  removeSessionState,
} from "../adapters/openchamber/prompt";
import { getPendingBlockingRequestsSnapshot, toOpenCodeFormRequest, toOpenCodePermissionRequest } from "../adapters/openchamber/approvals";
import { ocGoalOf } from "../adapters/openchamber/goal";
import { followedStatuses } from "../adapters/openchamber/follow";
import { attachOmpSessionContext } from "../adapters/openchamber/omp-context";
import { buildUsageStats } from "../adapters/openchamber/usage-stats";
import { page, toV2Session } from "../adapters/openchamber/v2";
import { attachOmpRecapAssist } from "../providers/omp/recap";
import { backendById, backendForSession, defaultBackend, listSessionsAcrossBackends, splitProviderPrefix } from "../providers/registry";
import { emitOpenCodeV2Event, emitSessionCreated, emitSessionDeleted } from "../shared/sse";
import { logger } from "../shared/logger";
import type { RouteContext } from "../http/router";
import { asRecord, readJson } from "../http/response";
import { refuseIfOpenElsewhere, resolveSessionRoute } from "../services/session-route";

/** Sessions this sidecar is driving plus those it only follows in another omp. */
const allSessionStatuses = (directory?: string) => ({ ...followedStatuses(directory), ...getSessionStatusMap(directory) });

const sessionInstructionEntries = new Map<string, Map<string, string>>();

export async function handleSessions(ctx: RouteContext): Promise<Response | undefined> {
  const { req, url, path, p, dir, json, jsonError, noContent } = ctx;
  // OpenChamber's cross-project status seed is distinct from OpenCode's
  // /session/status route below. Expose the host snapshot shape while
  // preserving the existing OpenCode-compatible endpoint unchanged.
  if (path === "/api/sessions/status" && req.method === "GET") {
    await reconcileSessionStatuses();
    const now = Date.now();
    const sessions = Object.fromEntries(
      Object.entries(allSessionStatuses()).map(([sessionId, status]) => [sessionId, {
        status: status.type,
        lastUpdateAt: now,
      }]),
    );
    const pending = Object.fromEntries(
      Object.entries(getPendingBlockingRequestsSnapshot()).map(([sessionID, requests]) => [sessionID, {
        permissions: requests.permissions.map(toOpenCodePermissionRequest),
        forms: requests.questions.map(toOpenCodeFormRequest),
      }]),
    );
    return json({
      sessions,
      pending,
      serverTime: now,
    });
  }

  // Create session (POST /session)
  if (p === "/session" && req.method === "POST") {
    try {
      const body = asRecord(await readJson(req)) ?? {};
      const location = asRecord(body.location);
      const model = asRecord(body.model);
      const sessionDirectory = typeof location?.directory === "string" ? location.directory : dir;
      // D1: a namespaced model prefix selects the backend for the new
      // session; absent or unknown prefix falls through to the default.
      const requestedProvider = typeof model?.providerID === "string" ? model.providerID : "";
      const prefix = splitProviderPrefix(requestedProvider);
      const backend = (prefix.backendId ? backendById(prefix.backendId) : undefined) ?? defaultBackend();
      const modelID = typeof model?.id === "string" ? model.id : typeof model?.modelID === "string" ? model.modelID : undefined;
      const session = await backend.store.create(sessionDirectory, {
        id: typeof body.id === "string" ? body.id : undefined,
        title: typeof body.title === "string" ? body.title : undefined,
        parentID: typeof body.parentID === "string" ? body.parentID : undefined,
        agent: typeof body.agent === "string" ? body.agent : undefined,
        model: modelID && requestedProvider ? {
          providerID: prefix.native,
          modelID,
          variant: typeof model?.variant === "string" ? model.variant : "default",
        } : undefined,
        metadata: asRecord(body.metadata) ?? undefined,
      });
      emitSessionCreated(session as unknown as Record<string, unknown>, session.directory);
      return json({ data: toV2Session(session) });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "create failed", 500);
    }
  }

  // Experimental session list
  if (p === "/experimental/session" && req.method === "GET") {
    try {
      const roots = url.searchParams.get("roots") === "true";
      const archivedParam = url.searchParams.get("archived");
      const archived = archivedParam === "true" ? true : archivedParam === "false" ? false : undefined;
      const limit = url.searchParams.get("limit");
      const search = url.searchParams.get("search") || url.searchParams.get("query") || url.searchParams.get("q") || undefined;
      const all = roots || url.searchParams.get("all") === "true" || !dir;
      const sessions = await listSessionsAcrossBackends(all ? null : dir, {
        all,
        archived,
        limit: limit != null ? parseInt(limit, 10) : undefined,
        search,
      });
      return json(attachOmpRecapAssist(sessions));
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "list failed", 500);
    }
  }

  // Stats page. Built from the transcripts omp wrote.
  if (p === "/experimental/session/stats" && req.method === "GET") {
    try {
      const num = (name: string) => {
        const value = Number(url.searchParams.get(name));
        return url.searchParams.get(name) && Number.isFinite(value) ? value : undefined;
      };
      const data = await buildUsageStats({
        from: num("from"),
        to: num("to"),
        timezone: url.searchParams.get("timezone") || "UTC",
        tools: url.searchParams.get("tools") === "detail" ? "detail" : "none",
      });
      return json({ data });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "stats failed", 500);
    }
  }

  // Lists the UI probes; omp has no equivalents, so they are empty rather than missing.
  if ((p === "/websearch/provider" || p === "/plugin") && req.method === "GET") {
    return json({ data: [] });
  }

  // Session list (GET /session)
  if (p === "/session" && req.method === "GET") {
    try {
      const roots = url.searchParams.get("roots") === "true";
      const archivedParam = url.searchParams.get("archived");
      const archived = archivedParam === "true" ? true : archivedParam === "false" ? false : undefined;
      const limit = url.searchParams.get("limit");
      const search = url.searchParams.get("search") || url.searchParams.get("query") || url.searchParams.get("q") || undefined;
      const all = roots || url.searchParams.get("all") === "true" || !dir;
      const sessions = await listSessionsAcrossBackends(all ? null : dir, {
        all,
        archived,
        search,
      });
      const parentID = url.searchParams.get("parentID");
      const filtered = parentID === null
        ? sessions
        : sessions.filter((session) => session.parentID === (parentID === "null" ? undefined : parentID));
      const ordered = [...filtered].sort((a, b) => a.time.updated - b.time.updated);
      const order = url.searchParams.get("order") === "asc" ? "asc" : "desc";
      const requestedLimit = limit == null ? 100 : Number.parseInt(limit, 10);
      const pageLimit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 100;
      const currentPage = page(ordered, pageLimit, url.searchParams.get("cursor"), order);
      return json({ data: attachOmpRecapAssist(currentPage.data).map(toV2Session), cursor: currentPage.cursor });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "list failed", 500);
    }
  }

  // Session status
  if (p === "/session/status" && req.method === "GET") {
    await reconcileSessionStatuses(dir);
    return json(allSessionStatuses(dir));
  }

  // OpenCode v2 reports the global set of sessions with an active agent
  // loop and uses "running" as its status value. The SDK unwraps `data`,
  // so an unenveloped map reads as a failed call on the client.
  if (p === "/session/active" && req.method === "GET") {
    await reconcileSessionStatuses();
    const statuses = allSessionStatuses();
    return json({
      data: Object.fromEntries(Object.keys(statuses).map((sessionID) => [sessionID, { type: "running" }])),
    });
  }

  // Per-session instruction entries (OpenChamber's session knowledge pins
  // context here). The sidecar records them but omp does not read them, so
  // they are not part of the agent's prompt.
  const instructionMatch = p.match(/^\/experimental\/session\/([^/]+)\/instructions\/entries(?:\/([^/]+))?$/);
  if (instructionMatch) {
    const sessionKey = decodeURIComponent(instructionMatch[1]!);
    const entryKey = instructionMatch[2] ? decodeURIComponent(instructionMatch[2]) : undefined;
    const entries = sessionInstructionEntries.get(sessionKey) ?? new Map<string, string>();
    if (!entryKey && req.method === "GET") {
      return json({ data: [...entries].map(([key, value]) => ({ key, value })) });
    }
    if (entryKey && req.method === "PUT") {
      const body = asRecord(await readJson(req));
      if (typeof body?.value !== "string") return jsonError("value required", 400);
      entries.set(entryKey, body.value);
      sessionInstructionEntries.set(sessionKey, entries);
      return noContent();
    }
    if (entryKey && req.method === "DELETE") {
      entries.delete(entryKey);
      if (entries.size === 0) sessionInstructionEntries.delete(sessionKey);
      return noContent();
    }
  }

  // Mark-viewed. OpenChamber's web-server route (`/sessions/:id/view`)
  // wants a JSON ack; the OpenCode v2 SDK route (`/session/:id/view`)
  // wants 204 and carries the read as `time.viewed` on the session.
  const sessionViewMatch = p.match(/^\/sessions?\/([^/]+)\/view$/);
  if (sessionViewMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(sessionViewMatch[1]!);
    const { backend, session } = await resolveSessionRoute(sessionId, dir);
    if (!session) return jsonError("session not found", 404);
    const body = asRecord(await readJson(req));
    const idle = typeof body?.idle === "number" && Number.isFinite(body.idle) ? body.idle : Date.now();
    await backend.store.update(sessionId, { time: { viewed: idle } }, session.directory);
    return p.startsWith("/sessions/")
      ? json({ success: true, sessionId, viewed: true })
      : noContent();
  }

  const sessionMoveMatch = p.match(/^\/session\/([^/]+)\/move$/);
  if (sessionMoveMatch && req.method === "POST") {
    try {
      const sessionID = decodeURIComponent(sessionMoveMatch[1]!);
      const { backend, session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const body = asRecord(await readJson(req));
      if (typeof body?.directory !== "string" || !body.directory.trim()) return jsonError("directory required", 400);
      const moved = await backend.store.move(sessionID, body.directory, session.directory);
      if (!moved) return jsonError("session move failed", 500);
      emitOpenCodeV2Event("session.moved", {
        sessionID,
        projectID: moved.projectID,
        location: { directory: moved.directory },
      }, moved.directory);
      return noContent();
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "session move failed", 500);
    }
  }

  const syntheticMatch = p.match(/^\/session\/([^/]+)\/synthetic$/);
  if (syntheticMatch && req.method === "POST") {
    try {
      const sessionID = decodeURIComponent(syntheticMatch[1]!);
      const { session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const body = asRecord(await readJson(req));
      if (typeof body?.text !== "string") return jsonError("text required", 400);
      const item = addSessionSyntheticContext(sessionID, session.directory, {
        id: typeof body.id === "string" ? body.id : undefined,
        text: body.text,
        description: typeof body.description === "string" ? body.description : undefined,
        metadata: asRecord(body.metadata) ?? undefined,
      });
      return json({ data: item });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "synthetic message failed", 500);
    }
  }

  const sessionModelMatch = p.match(/^\/session\/([^/]+)\/model$/);
  if (sessionModelMatch && req.method === "POST") {
    try {
      const sessionID = decodeURIComponent(sessionModelMatch[1]!);
      const { backend, session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const body = asRecord(await readJson(req));
      const model = asRecord(body?.model);
      const providerID = typeof model?.providerID === "string" ? model.providerID : "";
      const modelID = typeof model?.id === "string" ? model.id : "";
      if (!providerID || !modelID) return jsonError("model providerID and id are required", 400);
      const prefix = splitProviderPrefix(providerID);
      if (prefix.backendId && backendById(prefix.backendId) !== backend) {
        return jsonError("model provider does not belong to this session's backend", 400);
      }
      const modelRef = {
        providerID: prefix.native,
        modelID,
        variant: typeof model?.variant === "string" ? model.variant : "default",
      };
      const held = await refuseIfOpenElsewhere(sessionID, session);
      if (held) return json({ _tag: "InvalidRequestError", message: held, error: held }, { status: 400 });
      const applied = await applySessionModel(sessionID, session.directory, session.path, modelRef);
      if (applied.error) {
        // omp rejected the model: don't record it as the session's model,
        // or the picker would show a model the session never runs.
        return jsonError(applied.error, 502);
      }
      const updated = await backend.store.update(sessionID, { model: modelRef }, session.directory);
      if (!updated) return jsonError("session not found", 404);
      emitOpenCodeV2Event("session.model.selected", {
        sessionID,
        model: { id: modelID, providerID, variant: modelRef.variant },
      }, session.directory);
      return noContent();
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "model switch failed", 500);
    }
  }

  const sessionAgentMatch = p.match(/^\/session\/([^/]+)\/agent$/);
  if (sessionAgentMatch && req.method === "POST") {
    try {
      const sessionID = decodeURIComponent(sessionAgentMatch[1]!);
      const { backend, session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const body = asRecord(await readJson(req));
      if (typeof body?.agent !== "string" || !body.agent) return jsonError("agent required", 400);
      const previous = session.agent;
      const updated = await backend.store.update(sessionID, { agent: body.agent }, session.directory);
      if (!updated) return jsonError("session not found", 404);
      emitOpenCodeV2Event("session.agent.selected", { sessionID, agent: body.agent, previous }, session.directory);
      return noContent();
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "agent switch failed", 500);
    }
  }

  // Single session routes: /session/:id
  const sMatch = p.match(/^\/session\/([^/]+)$/);
  if (sMatch) {
    const openCodeId = sMatch[1];
    if (req.method === "GET") {
      try {
        const { backend, session } = await resolveSessionRoute(openCodeId, dir);
        if (!session) return jsonError("session not found", 404);
        const withContext = await attachOmpSessionContext(backend, attachOmpRecapAssist([session])[0] ?? session);
        return json({ data: toV2Session(withContext) });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "lookup failed", 500);
      }
    }

    if (req.method === "DELETE") {
      try {
        const { backend, session } = await resolveSessionRoute(openCodeId, dir);
        if (!session) return jsonError("session not found", 404);
        const ok = await backend.store.delete(openCodeId, dir);
        removeSessionState(openCodeId, session.directory);
        emitSessionDeleted(openCodeId);
        return ok ? noContent() : jsonError("session not found", 404);
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "delete failed", 500);
      }
    }

    if (req.method === "PATCH") {
      try {
        const body = (await readJson(req)) as {
          title?: string;
          metadata?: Record<string, unknown>;
          time?: { archived?: number | null };
        } | undefined;
        const { backend, session } = await resolveSessionRoute(openCodeId, dir);
        const previousGoal = ocGoalOf(session?.metadata);
        const updated = await backend.store.update(
          openCodeId,
          { title: body?.title, metadata: body?.metadata, time: body?.time },
          dir,
        );
        if (!updated) return jsonError("session not found", 404);
        // OpenChamber's goal record is served by omp's own goal, not OpenChamber's audit loop.
        if (body?.metadata && "openchamber" in body.metadata && backend.capabilities.goals) {
          void applyGoalChange(openCodeId, updated.directory, updated.path, previousGoal, ocGoalOf(updated.metadata))
            .catch((err) => logger.warn({ err, sessionID: openCodeId }, "[goal] could not apply the goal change to omp"));
        }
        return noContent();
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "update failed", 500);
      }
    }
  }

  // Session children (subagents)
  const childrenMatch = p.match(/^\/session\/([^/]+)\/children$/);
  if (childrenMatch && req.method === "GET") {
    try {
      const children = await backendForSession(childrenMatch[1]).store.children(childrenMatch[1], dir);
      return json(children);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "children failed", 500);
    }
  }

  // Session fork
  const forkMatch = p.match(/^\/session\/([^/]+)\/fork$/);
  if (forkMatch && req.method === "POST") {
    try {
      const { backend, session } = await resolveSessionRoute(forkMatch[1], dir);
      if (!session) return jsonError("session not found", 404);
      const body = asRecord(await readJson(req));
      const before = typeof body?.before === "string" ? body.before : undefined;
      const forked = await backend.store.fork(forkMatch[1]!, session.directory, before);
      if (!forked) return jsonError(before ? "fork boundary not found" : "session fork failed", before ? 404 : 500);
      emitSessionCreated(forked as unknown as Record<string, unknown>, forked.directory);
      return json({ data: toV2Session(forked) });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "fork failed", 500);
    }
  }

  return undefined;
}
