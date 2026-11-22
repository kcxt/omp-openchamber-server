/**
 * Turn operations the HTTP routes call: prompt (incl. `.` resume and subagent
 * routing), abort, compact, model, goal, shell, and session teardown. Each
 * resolves the session's runtime through the Registry; none keeps state.
 */
import { goalChangeFor, ocGoalOf, type GoalChange } from "../adapters/openchamber/goal";
import { clearSessionApprovals } from "../adapters/openchamber/approvals";
import { Utility } from "../omp/utility";
import { CredentialInputError } from "../providers/omp/credentials";
import { isLowSignalTitleInput, normalizeGeneratedTitle } from "../providers/omp/title";
import { allBackends, backendById, backendForSession, nativeProviderID, splitProviderPrefix } from "../providers/registry";
import type { BackendCredentialInput, ModelRef, OpenCodeSession } from "../providers/types";
import { emitOpenCodeV2Event, emitSessionError } from "../shared/sse";
import { promptLogger } from "../shared/logger";
import {
  clearSessionSyntheticContext,
  emitUserPrompt,
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

async function generateTitle(session: OpenCodeSession, text: string): Promise<void> {
  if (!text || isLowSignalTitleInput(text)) return;
  const backend = backendForSession(session.id);
  const current = await backend.store.get(session.id, session.directory);
  if (!current || (current.title && !current.title.startsWith("Session ")) || !backend.capabilities.titleGeneration) return;
  const title = normalizeGeneratedTitle(text, text);
  if (title) await backend.store.setTitle(session.id, title, "auto", session.directory);
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

export async function promptSession(session: OpenCodeSession, body: unknown): Promise<PromptOutcome> {
  if (!isPromptBody(body)) return { queued: false, error: "invalid body", status: 400 };
  const prepared = await preparePrompt(session.id, session.directory, body);
  if ("error" in prepared) return { queued: false, error: prepared.error, status: 400 };
  if (isSubagentTranscript(session.path)) return promptSubagent(session, prepared.message, prepared.messageID);

  // D1: a namespaced model prefix must match the backend that owns this session.
  const requestedPrefix = splitProviderPrefix(body.model?.providerID ?? "").backendId;
  if (requestedPrefix && backendById(requestedPrefix) !== backendForSession(session.id)) {
    return { queued: false, status: 400, error: "model provider does not belong to this session's backend" };
  }
  // OpenCode's v2 prompt body carries no model: the pick lives on the session
  // record (set at create, or by POST /session/:id/model).
  const pick: ModelPick | undefined = body.model?.providerID && body.model?.modelID
    ? { providerID: nativeProviderID(body.model.providerID), modelID: body.model.modelID, variant: body.variant ?? "default" }
    : hasRealModel(session.model)
      ? { providerID: nativeProviderID(session.model.providerID), modelID: session.model.modelID, variant: session.model.variant ?? "default" }
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
  backendForSession(session.id).store.recordUserMessage?.(session.id, prepared.visibleText, prepared.messageID, prepared.visibleParts);

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
  // The title slot lives in omp's transcript: write it only once the run is over, never while omp appends.
  const title = () => void generateTitle(session, prepared.visibleText).catch(() => {});
  if (runtime.state === "idle") title();
  else {
    const unsubscribe = runtime.onStateChange(({ state }) => {
      if (state !== "idle" && state !== "closed") return;
      unsubscribe();
      title();
    });
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
    await runtime.setModel({ providerID: nativeProviderID(model.providerID), modelID: model.modelID, variant: model.variant });
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

/** `/session/:id/shell`: through the session's runtime when it has one, else the shared utility child. */
export function runShell(session: OpenCodeSession, command: string): Promise<unknown> {
  const runtime = Registry.get(session.id, session.directory);
  return runtime ? runtime.bash(command) : Utility.for(session.directory).bash(command);
}

/**
 * Drops the runtime holding a session (after the transcript changed under it,
 * or to release its lease). The next prompt opens the session afresh.
 */
export function discardSession(sessionId: string, cwd: string): void {
  Registry.close(sessionId, cwd, "replaced");
}

/** The session was deleted: its runtime, pending synthetic context and approvals go. */
export function removeSession(sessionId: string, cwd: string): void {
  Registry.close(sessionId, cwd, "deleted");
  clearSessionSyntheticContext(sessionId, cwd);
  clearSessionApprovals(sessionId);
}

/** Process shutdown: every runtime and backend child. */
export function shutdownSessions(): void {
  Registry.shutdown();
  for (const backend of allBackends()) {
    try {
      backend.shutdownAll();
    } catch {
      /* ignore */
    }
  }
}
