/**
 * Turn operations the HTTP routes call: prompt (incl. `.` resume and subagent
 * routing), abort, compact, model, goal, shell, and session teardown. Each
 * resolves the session's runtime through the Registry; none keeps state.
 */
import { goalChangeFor, ocGoalOf, type GoalChange } from "../adapters/openchamber/goal";
import { clearSessionApprovals } from "../adapters/openchamber/approvals";
import { SessionDocs } from "../store/session-docs";
import { CredentialInputError } from "../omp/credentials";
import { asideMessageIds } from "../omp/btw-history";
import { locateMessage } from "../omp/messages";
import { getOmpSessionByOpenCodeId, readSessionIdSync, toOpenCodeSessionId } from "../store/sessions";
import { OmpCli } from "../omp/cli";
import { RpcChild } from "../omp/rpc-child";
import type { BackendCredentialInput, ModelRef, OpenCodeSession } from "../shared/types";
import { emitOpenCodeV2Event, emitSessionError, emitSessionUpdated } from "../shared/sse";
import { promptLogger } from "../shared/logger";
import {
  clearSessionSyntheticContext,
  emitUserPrompt,
  extractPromptTextParts,
  isPromptBody,
  preparePrompt,
} from "./prompt-input";
import { Registry, isSubagentTranscript } from "./registry";
import { OwnedElsewhereError, type ModelPick, type SessionRuntime, type Withdrawn } from "./runtime";

export interface PromptOutcome {
  queued: boolean;
  messageID?: string;
  error?: string;
  status?: number;
}

/** The omp store's stand-in for a session with no recorded model. */
function hasRealModel(model: Partial<ModelRef> | undefined): model is ModelRef {
  return typeof model?.providerID === "string" && typeof model?.modelID === "string" && !(model.providerID === "omp" && model.modelID === "omp");
}

function failure(err: unknown): PromptOutcome {
  if (err instanceof CredentialInputError) return { queued: false, error: err.message, status: err.statusCode };
  if (err instanceof OwnedElsewhereError) return { queued: false, error: err.message, status: 400 };
  return { queued: false, error: err instanceof Error ? err.message : String(err), status: 500 };
}

/** A prompt to a subagent's session goes to its parent's runtime: steer while it runs, `.` resumes it. */
async function promptSubagent(session: OpenCodeSession, text: string, messageID: string): Promise<PromptOutcome> {
  const found = Registry.findSubagent(session.id);
  if (!found) {
    return { queued: false, status: 409, error: "This subagent belongs to a session that is not running here. Send to the parent session instead." };
  }
  const { runtime, subagent } = found;
  try {
    if (text.trim() === ".") await runtime.resume({ subagentId: subagent.id });
    else if (subagent.status === "running") await runtime.steerSubagent(subagent.id, text);
    else return { queued: false, status: 409, error: "This subagent has finished. Send \".\" to resume it, or continue in the parent session." };
  } catch (err) {
    return { queued: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  return { queued: true, messageID };
}

/** The question of an `/aside <question>` prompt (typed, or sent as the `aside` command); undefined for any other prompt. */
export function asideQuestionOf(body: unknown): string | undefined {
  if (!isPromptBody(body)) return undefined;
  const text = extractPromptTextParts(body).filter((part) => part.synthetic !== true).map((part) => part.text).join("\n\n").trim();
  const match = /^\/aside(?:\s+([\s\S]*))?$/i.exec(text);
  return match ? (match[1] ?? "").trim() : undefined;
}

/**
 * `/aside`: omp's `/btw` on the session's runtime (started when none is live;
 * refused when another omp owns the session). It works mid-run and does not
 * change the session's status. The messages come from the runtime's frames.
 */
async function askAside(session: OpenCodeSession, question: string): Promise<PromptOutcome> {
  if (!question) return { queued: false, status: 400, error: "Usage: /aside <question>" };
  if (isSubagentTranscript(session.path)) return { queued: false, status: 409, error: "Side questions are asked in the parent session." };
  try {
    const runtime = await Registry.ensure(session);
    const topic = await runtime.btw(question);
    return { queued: true, messageID: asideMessageIds(session.id, topic.id, 0, topic.createdAt).userId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof OwnedElsewhereError) return { queued: false, error: message, status: 409 };
    return { queued: false, error: message, status: /still running/i.test(message) ? 409 : 500 };
  }
}

export async function promptSession(session: OpenCodeSession, body: unknown): Promise<PromptOutcome> {
  if (!isPromptBody(body)) return { queued: false, error: "invalid body", status: 400 };
  const question = asideQuestionOf(body);
  if (question !== undefined) return askAside(session, question);
  const prepared = await preparePrompt(session.id, session.directory, body);
  if ("error" in prepared) return { queued: false, error: prepared.error, status: 400 };
  if (isSubagentTranscript(session.path)) return promptSubagent(session, prepared.message, prepared.messageID);

  // OpenCode's v2 prompt body carries no model: the pick lives on the session
  // record (set at create, or by POST /session/:id/model).
  const pick: ModelPick | undefined = body.model?.providerID && body.model?.modelID
    ? { providerID: body.model.providerID, modelID: body.model.modelID, variant: body.variant ?? "default" }
    : hasRealModel(session.model)
      ? { providerID: session.model.providerID, modelID: session.model.modelID, variant: session.model.variant ?? "default" }
      : undefined;
  if (body.credentials !== undefined && body.credentialRef !== undefined) {
    return { queued: false, error: "provide exactly one of credentials or credentialRef", status: 400 };
  }
  const auth: BackendCredentialInput | undefined = body.credentials !== undefined
    ? { credentials: body.credentials, selectedProviderID: pick?.providerID, selectedModelID: pick?.modelID }
    : body.credentialRef !== undefined
      ? { credentialRef: body.credentialRef, selectedProviderID: pick?.providerID, selectedModelID: pick?.modelID }
      : undefined;

  let runtime: SessionRuntime;
  try {
    runtime = await Registry.ensure(session, auth);
  } catch (err) {
    return failure(err);
  }

  if (pick) {
    // A turn must never run on the model the child booted with; a pick made
    // mid-run applies to the runs that follow and must not drop the message.
    if (runtime.state === "idle") {
      try {
        await runtime.setModel(pick);
      } catch (err) {
        return { queued: false, error: err instanceof Error ? err.message : String(err), status: 502 };
      }
    } else {
      void runtime.setModel(pick).catch((err) => promptLogger.warn({ err, sessionID: session.id }, "[prompt] model pick not applied mid-run"));
    }
  }

  emitUserPrompt(session.id, session.directory, prepared, body, runtime.model);
  if (prepared.message !== prepared.visibleText || prepared.visibleParts.length > 1) {
    // The transcript holds the whole message; what the user typed is the sidecar's to remember.
    const uuid = readSessionIdSync(session.path);
    if (uuid) {
      await SessionDocs.update(uuid, (draft) => {
        draft.visibleParts = { ...draft.visibleParts, [prepared.messageID]: prepared.visibleParts };
      }).catch((err) => promptLogger.warn({ err, sessionID: session.id }, "[prompt] could not record the visible prompt parts"));
    }
  }

  try {
    // `.` alone is omp's continue (P5): no message reaches the model.
    if (prepared.message.trim() === "." && prepared.images.length === 0) {
      await runtime.resume({ hostMessageId: prepared.messageID });
      emitOpenCodeV2Event("session.inbox.delivered", { sessionID: session.id, inboxID: prepared.messageID }, session.directory);
    } else {
      await runtime.prompt({
        message: prepared.message,
        images: prepared.images,
        hostMessageId: prepared.messageID,
        delivery: body.delivery === "steer" ? "steer" : "queue",
      });
    }
  } catch (err) {
    emitSessionError(session.id, err, session.directory);
    promptLogger.error({ err, sessionID: session.id }, "[prompt] omp refused the prompt");
    return failure(err);
  }
  return { queued: true, messageID: prepared.messageID };
}

/**
 * OpenChamber's restart continuation (`synthetic { resume: true, metadata.notice:
 * "opencode-restart" }`): omp's recovery directive continues the interrupted
 * turn instead of a synthetic text prompt.
 */
export async function resumeAfterRestart(session: OpenCodeSession): Promise<void> {
  const runtime = await Registry.ensure(session);
  await runtime.resume({});
}

export interface AbortOutcome {
  stopped: boolean;
  withdrawn?: Withdrawn;
}

/** Esc. On a subagent session it cancels that subagent only. */
export async function abortSession(session: OpenCodeSession): Promise<AbortOutcome> {
  const child = Registry.findSubagent(session.id);
  if (child) {
    if (child.subagent.status !== "running") return { stopped: false };
    await child.runtime.cancelSubagent(child.subagent.id);
    return { stopped: true };
  }
  const runtime = Registry.get(session.id, session.directory);
  if (!runtime) return { stopped: false };
  const withdrawn = await runtime.abort();
  // The withdrawn input was never sent: its pending inbox bubbles go away.
  for (const inboxID of withdrawn.inboxIDs) {
    emitOpenCodeV2Event("session.inbox.cancelled", { sessionID: session.id, inboxID }, session.directory);
  }
  return { stopped: true, withdrawn };
}

/** Compacts through the session's own runtime (a fresh child would compact its own empty session). */
export async function compactSession(session: OpenCodeSession): Promise<void> {
  const runtime = await Registry.ensure(session);
  await runtime.compact();
}

/** Applies a model pick at once, starting a runtime when none is live; omp journals it. */
export async function applySessionModel(session: OpenCodeSession, model: ModelRef): Promise<{ applied: boolean; error?: string }> {
  try {
    const runtime = await Registry.ensure(session);
    await runtime.setModel({ providerID: model.providerID, modelID: model.modelID, variant: model.variant });
    return { applied: true };
  } catch (err) {
    return { applied: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Starts (or restarts) omp's goal from what OpenChamber armed. A goal omp still
 * holds from an earlier arming is dropped first: omp allows one goal at a time.
 */
async function startOmpGoal(runtime: SessionRuntime, change: Extract<GoalChange, { op: "start" | "resume" }>): Promise<void> {
  const held = await runtime.getGoal().catch(() => null);
  if (change.op === "resume" && held) {
    if (held.status === "active") await runtime.goal("pause").catch(() => {}); // re-arms continuation, which omp stopped
    if (held.status === "active" || held.status === "paused") {
      await runtime.goal("resume");
      return;
    }
  }
  if (held && held.status !== "complete" && held.status !== "dropped") await runtime.goal("drop").catch(() => {});
  await runtime.goal("create", { objective: change.objective, tokenBudget: change.tokenBudget });
}

/** Applies a change OpenChamber made to the session's goal record to omp's goal; omp runs the continuations. */
export async function applyGoalChange(session: OpenCodeSession, prev: unknown, next: unknown): Promise<void> {
  const change = await goalChangeFor(session.id, ocGoalOf({ openchamber: { goal: prev } }), ocGoalOf({ openchamber: { goal: next } }));
  if (!change) return;
  if (change.op === "pause" || change.op === "drop") {
    await Registry.get(session.id, session.directory)?.goal(change.op);
    return;
  }
  await startOmpGoal(await Registry.ensure(session), change);
}

/** `/session/:id/shell`: through the session's runtime when it has one, else a plain shell in the session's directory. */
export async function runShell(session: OpenCodeSession, command: string): Promise<unknown> {
  const runtime = Registry.get(session.id, session.directory);
  if (runtime) return runtime.bash(command);
  const proc = Bun.spawn(["bash", "-c", command], { cwd: session.directory, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { output: stdout + stderr, exitCode };
}

/** A failure of a session operation the HTTP layer reports with `status`. */
export class SessionOpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SessionOpError";
  }
}

/** The runtime for an operation that needs omp: an owner elsewhere is a 409, not a crash. */
async function runtimeFor(session: OpenCodeSession): Promise<SessionRuntime> {
  try {
    return await Registry.ensure(session);
  } catch (err) {
    if (err instanceof OwnedElsewhereError) throw new SessionOpError(err.message, 409);
    throw err;
  }
}

/** omp refusing while a run is live (`session_busy`) is a conflict. */
function asConflict(err: unknown): never {
  if (err instanceof SessionOpError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  throw new SessionOpError(message, /busy|running|streaming/i.test(message) ? 409 : 500);
}

function docKeyOf(session: OpenCodeSession): string {
  const uuid = readSessionIdSync(session.path);
  if (!uuid) throw new SessionOpError("session transcript has no header", 500);
  return uuid;
}

/**
 * Staged revert (§3.9): omp's leaf moves to the message's parent now and a
 * `host-revert` entry makes it durable; the abandoned leaf is kept in the doc
 * so redo can go back. A second stage while one is staged keeps the first redo leaf.
 */
export async function stageRevert(session: OpenCodeSession, messageID: string): Promise<{ messageID: string }> {
  const located = await locateMessage(session.id, session.path, messageID);
  if (!located) throw new SessionOpError("revert boundary not found", 404);
  if (!located.userMessage) throw new SessionOpError("only a user message can be reverted to", 400);
  const doc = await SessionDocs.get(located.uuid);
  if (doc.revert?.messageID === messageID) return { messageID };
  const runtime = await runtimeFor(session);
  const redoLeafId = doc.revert?.redoLeafId ?? located.leafId ?? undefined;
  try {
    await runtime.navigateTo(located.entryId, { action: "revert", messageID });
  } catch (err) {
    asConflict(err);
  }
  await SessionDocs.update(located.uuid, (draft) => {
    draft.revert = { messageID, ...(redoLeafId ? { redoLeafId } : {}) };
  });
  return { messageID };
}

/** Redo: back to the leaf the staged revert abandoned, then the marker goes. A marker with no redo leaf (migrated) is only dropped. */
export async function clearRevert(session: OpenCodeSession): Promise<boolean> {
  const uuid = docKeyOf(session);
  const staged = (await SessionDocs.get(uuid)).revert;
  if (!staged) return false;
  if (staged.redoLeafId) {
    const runtime = await runtimeFor(session);
    try {
      await runtime.navigateTo(staged.redoLeafId, { action: "redo", messageID: staged.messageID });
    } catch (err) {
      asConflict(err);
    }
  }
  await SessionDocs.update(uuid, (draft) => { delete draft.revert; });
  return true;
}

/** The staged revert is accepted: the transcript already holds it, only the marker goes. */
export async function commitRevert(session: OpenCodeSession): Promise<boolean> {
  const uuid = docKeyOf(session);
  if (!(await SessionDocs.get(uuid)).revert) return false;
  await SessionDocs.update(uuid, (draft) => { delete draft.revert; });
  return true;
}

/**
 * omp's `fork` (the whole conversation) or, with `before`, the history before
 * that message (`branch` for a user message, `fork` at the entry before it
 * otherwise). OpenChamber's metadata goes with it; the title is omp's slot.
 */
export async function forkSession(session: OpenCodeSession, before?: string): Promise<OpenCodeSession> {
  let target: { entryId: string; before: boolean } | undefined;
  if (before) {
    const located = await locateMessage(session.id, session.path, before);
    if (!located) throw new SessionOpError("fork boundary not found", 404);
    if (located.userMessage) target = { entryId: located.entryId, before: true };
    else if (located.parentId) target = { entryId: located.parentId, before: false };
    else throw new SessionOpError("nothing before this message to fork", 400);
  }
  const uuid = docKeyOf(session);
  const runtime = await runtimeFor(session);
  const parentDoc = await SessionDocs.get(uuid);
  let forked: { transcriptPath: string; sessionId: string };
  try {
    forked = await runtime.fork(target, `Fork of ${session.title ?? session.id}`);
  } catch (err) {
    asConflict(err);
  }
  await SessionDocs.update(forked.sessionId, (draft) => {
    draft.metadata = { ...parentDoc.metadata };
    // Entry ids and client ids carry over into the copy, so their maps do too.
    if (parentDoc.legacyMessageIds) draft.legacyMessageIds = { ...parentDoc.legacyMessageIds };
    if (parentDoc.visibleParts) draft.visibleParts = { ...parentDoc.visibleParts };
  });
  const created = await getOmpSessionByOpenCodeId(toOpenCodeSessionId(forked.sessionId), session.directory);
  if (!created) throw new SessionOpError("the forked session was not found", 500);
  return created;
}

/** omp's `/move <dir>`; its refusal text becomes the error. */
export async function moveSession(session: OpenCodeSession, directory: string): Promise<OpenCodeSession> {
  const runtime = await runtimeFor(session);
  try {
    await runtime.move(directory);
  } catch (err) {
    asConflict(err);
  }
  const moved = await getOmpSessionByOpenCodeId(session.id);
  if (!moved) throw new SessionOpError("the moved session was not found", 500);
  return moved;
}

/** A rename is omp's `set_session_name`: a runtime is started when none is live. */
export async function renameSession(session: OpenCodeSession, title: string): Promise<OpenCodeSession> {
  const clean = title.replace(/\r?\n/g, " ").trim();
  if (!clean) throw new SessionOpError("title required", 400);
  const runtime = await runtimeFor(session);
  await runtime.setName(clean);
  const updated = (await getOmpSessionByOpenCodeId(session.id, session.directory)) ?? { ...session, title: clean };
  emitSessionUpdated(updated as unknown as Record<string, unknown>, updated.directory);
  emitOpenCodeV2Event("session.renamed", { sessionID: session.id, title: clean }, updated.directory);
  return updated;
}

/** The session was deleted: its runtime, pending synthetic context and approvals go. */
export function removeSession(sessionId: string, cwd: string): void {
  Registry.close(sessionId, cwd, "deleted");
  clearSessionSyntheticContext(sessionId, cwd);
  clearSessionApprovals(sessionId);
}

/** Process shutdown: every runtime and omp child. */
export function shutdownSessions(): void {
  Registry.shutdown();
  OmpCli.shutdown();
  RpcChild.killAll();
}
