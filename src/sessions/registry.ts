/**
 * The only map of live driven sessions (kind: resource handles). Creation is
 * single-flight per session, and only root sessions get a runtime: a subagent
 * session is driven through its parent's runtime, never by a second omp child
 * writing the parent's artifact file.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { credentialInputFingerprint, resolveBackendCredentials } from "../omp/credentials";
import { withOmpRecapAssist } from "./recap";
import { getOmpSessionByOpenCodeId, updateOmpSession } from "../store/sessions";
import type { BackendCredentialInput, BackendGoalSnapshot } from "../shared/types";
import { ocPatchForOmpGoal, withGoalPatch, type OcGoal } from "../adapters/openchamber/goal";
import { writeMetadataThroughOpenChamber } from "../adapters/openchamber/metadata-bridge";
import { emitOpenCodeV2Event, emitSessionIdle, emitSessionStatus } from "../shared/sse";
import { promptLogger } from "../shared/logger";
import { SessionRuntime, type CloseReason, type RuntimeState, type SubagentInfo } from "./runtime";

export interface SessionRef {
  id: string;
  directory: string;
  path: string;
}

const runtimes = new Map<string, SessionRuntime>();
const creating = new Map<string, Promise<SessionRuntime>>();

const keyOf = (sessionId: string, cwd: string) => `${sessionId}\0${cwd}`;

/** What OpenChamber is told for a runtime state; `starting` publishes nothing until the session is open. */
const busyOf = (state: RuntimeState): boolean => state === "active" || state === "aborting";

/** An omp subagent's transcript lives in its parent's artifact directory, next to `<parent>.jsonl`. */
export function isSubagentTranscript(path: string): boolean {
  return existsSync(`${dirname(path)}.jsonl`);
}

/**
 * Mirrors omp's goal into OpenChamber's goal record. omp settles a goal itself
 * (the agent calls the `goal` tool); a stretch that settles with the goal still
 * active means omp stopped continuing it, which OpenChamber shows as blocked.
 *
 * A goal that settles goes through OpenChamber's metadata route: its UI only
 * learns of a metadata change from OpenChamber's own broadcast, and that route
 * stores the change (back through this sidecar's PATCH, which maps a settled
 * goal to no omp operation), broadcasts it and re-arms its goal runtime. When
 * OpenChamber cannot be reached the session document is written directly. A
 * progress tick (`tokensUsed` of a goal still active) needs no broadcast.
 */
async function mirrorGoal(runtime: SessionRuntime, goal: BackendGoalSnapshot | null, stalled: boolean): Promise<void> {
  const patch: Partial<OcGoal> = {
    ...ocPatchForOmpGoal(goal),
    ...(stalled
      ? { status: "blocked", statusReason: "The agent made no progress on its last goal turn. Send a message or resume the goal to continue." }
      : {}),
  };
  if (Object.keys(patch).length === 0) return;
  try {
    const session = await getOmpSessionByOpenCodeId(runtime.sessionId, runtime.cwd);
    const metadata = withGoalPatch(session?.metadata, patch);
    if (!metadata) return;
    const settles = patch.status !== undefined && patch.status !== "active";
    const goalRecord = (metadata.openchamber as Record<string, unknown>).goal;
    if (settles && (await writeMetadataThroughOpenChamber(runtime.sessionId, { openchamber: { goal: goalRecord } }, runtime.cwd))) return;
    await updateOmpSession(runtime.sessionId, { metadata }, runtime.cwd);
  } catch (err) {
    promptLogger.warn({ err, sessionID: runtime.sessionId }, "[goal] could not mirror omp's goal into the session metadata");
  }
}

async function publishRecap(runtime: SessionRuntime, recap: string, createdAt: number, forMessageID: string | undefined): Promise<void> {
  try {
    const session = await getOmpSessionByOpenCodeId(runtime.sessionId, runtime.cwd);
    const metadata = session ? await withOmpRecapAssist(session, recap, createdAt, forMessageID) : null;
    if (metadata) await updateOmpSession(runtime.sessionId, { metadata }, runtime.cwd);
  } catch (err) {
    promptLogger.warn({ err, sessionID: runtime.sessionId }, "[recap] could not publish omp's recap");
  }
}

async function publishUsage(runtime: SessionRuntime): Promise<void> {
  const session = await getOmpSessionByOpenCodeId(runtime.sessionId, runtime.cwd).catch(() => null);
  if (session) emitOpenCodeV2Event("session.usage.updated", { sessionID: runtime.sessionId, cost: session.cost, tokens: session.tokens }, runtime.cwd);
}

function adopt(key: string, runtime: SessionRuntime): void {
  runtimes.set(key, runtime);
  // Status is a function of the runtime state: an event goes out only when its busy/idle value changes.
  runtime.onStateChange(({ state, previous, aborted }) => {
    if (state === "closed" && runtimes.get(key) === runtime) runtimes.delete(key);
    if (busyOf(state) === busyOf(previous)) return;
    if (busyOf(state)) {
      emitSessionStatus(runtime.sessionId, { type: "busy" }, runtime.cwd);
      return;
    }
    emitSessionStatus(runtime.sessionId, { type: "idle" }, runtime.cwd);
    emitSessionIdle(runtime.sessionId, runtime.cwd, aborted === true);
    void publishUsage(runtime);
  });
  runtime.onGoalUpdate((goal, stalled) => void mirrorGoal(runtime, goal, stalled));
  runtime.onRecap((recap, createdAt, forMessageID) => void publishRecap(runtime, recap, createdAt, forMessageID));
}

export const Registry = {
  /** The live runtime driving a session, if any. */
  get(sessionId: string, cwd: string): SessionRuntime | undefined {
    const runtime = runtimes.get(keyOf(sessionId, cwd));
    return runtime && runtime.state !== "closed" ? runtime : undefined;
  },

  /** A runtime for the session is being spawned (its status is busy). */
  isStarting(sessionId: string, cwd: string): boolean {
    return creating.has(keyOf(sessionId, cwd));
  },

  all(): SessionRuntime[] {
    return [...runtimes.values()].filter((runtime) => runtime.state !== "closed");
  },

  /**
   * The session's runtime, spawning one when none is live. Caller-owned
   * credentials that differ from the live child's replace an idle child.
   */
  async ensure(session: SessionRef, auth?: BackendCredentialInput): Promise<SessionRuntime> {
    if (isSubagentTranscript(session.path)) throw new Error("A subagent session is driven by its parent session.");
    const key = keyOf(session.id, session.directory);
    const fingerprint = auth ? credentialInputFingerprint(auth) : undefined;
    const live = Registry.get(session.id, session.directory);
    if (live) {
      if (auth === undefined || live.credentialFingerprint === fingerprint) return live;
      if (live.state !== "idle") throw new Error("session is busy; wait for the turn to finish before changing its credentials");
      live.close("replaced");
    }
    const pending = creating.get(key);
    if (pending) return pending;
    const created = (async () => {
      const credential = await resolveBackendCredentials(auth, { cwd: session.directory, openCodeId: session.id });
      const runtime = await SessionRuntime.spawn({
        sessionId: session.id,
        cwd: session.directory,
        transcriptPath: session.path,
        ...(credential ? { credential, credentialFingerprint: fingerprint } : {}),
      });
      adopt(key, runtime);
      return runtime;
    })();
    creating.set(key, created);
    try {
      return await created;
    } finally {
      creating.delete(key);
    }
  },

  /** The parent runtime and snapshot of the subagent whose child session this is. */
  findSubagent(childSessionId: string): { runtime: SessionRuntime; subagent: SubagentInfo } | undefined {
    for (const runtime of Registry.all()) {
      const subagent = runtime.subagentByChild(childSessionId);
      if (subagent) return { runtime, subagent };
    }
    return undefined;
  },

  close(sessionId: string, cwd: string, reason: CloseReason): void {
    Registry.get(sessionId, cwd)?.close(reason);
  },

  shutdown(): void {
    for (const runtime of Registry.all()) runtime.close("shutdown");
    runtimes.clear();
  },
};
