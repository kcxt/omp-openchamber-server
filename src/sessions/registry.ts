/**
 * The only map of live driven sessions (kind: resource handles). Creation is
 * single-flight per session, and only root sessions get a runtime: a subagent
 * session is driven through its parent's runtime, never by a second omp child
 * writing the parent's artifact file.
 */
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { credentialInputFingerprint, resolveBackendCredentials } from "../omp/credentials";
import { liveChildUnits, readRecords, removeRecord, stopChildUnit, supervised } from "../omp/supervisor";
import { withOmpRecapAssist } from "./recap";
import { getOmpSessionByOpenCodeId, updateOmpSession } from "../store/sessions";
import type { BackendCredentialInput } from "../shared/types";
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

  /**
   * Takes over the supervised omp children a previous sidecar left running (`omp/supervisor.ts`). A
   * record whose unit is gone is dropped; a running unit nobody has a record for is stopped.
   */
  async adoptAll(): Promise<void> {
    if (!supervised()) return;
    const live = await liveChildUnits();
    const known = new Set<string>();
    for (const record of readRecords()) {
      known.add(record.unit);
      if (!live.has(record.unit) || !record.sessionId) {
        if (live.has(record.unit)) await stopChildUnit(record.unit);
        if (record.credentialDir) rmSync(record.credentialDir, { recursive: true, force: true });
        removeRecord(record);
        continue;
      }
      try {
        const runtime = await SessionRuntime.adopt(record);
        adopt(keyOf(runtime.sessionId, runtime.cwd), runtime);
        // The runtime was busy before anyone listened.
        if (busyOf(runtime.state)) emitSessionStatus(runtime.sessionId, { type: "busy" }, runtime.cwd);
        promptLogger.info({ sessionID: runtime.sessionId, unit: record.unit, state: runtime.state }, "[runtime] adopted a running omp child");
      } catch (err) {
        promptLogger.warn({ err, sessionID: record.sessionId, unit: record.unit }, "[runtime] could not adopt an omp child; stopping it");
        await stopChildUnit(record.unit);
      }
    }
    for (const unit of live) if (!known.has(unit)) await stopChildUnit(unit);
  },

  /** Sidecar shutdown: supervised children stay for the next sidecar, the rest are closed. */
  shutdown(): void {
    for (const runtime of Registry.all()) {
      if (supervised()) runtime.release();
      else runtime.close("shutdown");
    }
    runtimes.clear();
  },
};
