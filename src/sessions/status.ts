/**
 * Status is a function (PLAN §3.5), computed when asked:
 *  - driven (a live runtime): `starting|active|aborting` → busy, `idle` → idle;
 *  - a subagent of a driven parent: busy while the parent's snapshot says running;
 *  - otherwise lease first, tail second: no lease holder → idle; a holder →
 *    busy iff the transcript tail is mid-turn; a failed probe → unknown.
 * A parent's status never includes its children's.
 */
import { followedStatuses } from "../adapters/openchamber/follow";
import { backendForSession } from "../providers/registry";
import type { OpenCodeMessageRecord } from "../providers/types";
import { Registry } from "./registry";
import type { BackgroundJob, RuntimeState } from "./runtime";

export type SessionStatus = "busy" | "idle" | "unknown";

const statusOfState = (state: RuntimeState): "busy" | "idle" => (state === "idle" || state === "closed" ? "idle" : "busy");

/** A transcript whose last message is an unanswered user message or an assistant step waiting on tools. */
export function isMidTurn(records: OpenCodeMessageRecord[]): boolean {
  const last = records.at(-1);
  if (!last) return false;
  if (last.info.role === "user") return true;
  if (last.info.role !== "assistant") return false;
  if (last.parts.some((part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"))) return true;
  return last.info.finish === "toolUse" || last.info.finish === "tool-calls" || last.info.finish === "tool_calls";
}

/** Whether this sidecar holds a live omp child for the session (it, not a transcript tail, emits its events). */
export function isSessionDriven(sessionId: string, cwd: string): boolean {
  return Registry.get(sessionId, cwd) !== undefined || Registry.isStarting(sessionId, cwd);
}

/**
 * Whether another process (typically a terminal omp) owns the session's
 * transcript, so sending from here would fork it. The sidecar's own runtime
 * counts as the owner. `undefined` when ownership could not be determined;
 * callers must not read it as free.
 */
export async function sessionOwnedElsewhere(sessionId: string, cwd: string, transcriptPath: string): Promise<boolean | undefined> {
  if (isSessionDriven(sessionId, cwd)) return false;
  const backend = backendForSession(sessionId);
  return backend.sessionOwnedElsewhere ? backend.sessionOwnedElsewhere(cwd, transcriptPath) : false;
}

export async function statusOf(sessionId: string, cwd: string, transcriptPath: string): Promise<SessionStatus> {
  const runtime = Registry.get(sessionId, cwd);
  if (runtime) return statusOfState(runtime.state);
  if (Registry.isStarting(sessionId, cwd)) return "busy";
  const child = Registry.findSubagent(sessionId);
  if (child) return child.subagent.status === "running" ? "busy" : "idle";
  const lease = await sessionOwnedElsewhere(sessionId, cwd, transcriptPath);
  if (lease === undefined) return "unknown";
  if (!lease) return "idle";
  const records = await backendForSession(sessionId).store.transcript(sessionId, cwd).catch(() => null);
  return records ? (isMidTurn(records) ? "busy" : "idle") : "unknown";
}

/** Busy sessions this sidecar drives, and their running subagents' child sessions. */
export function drivenStatuses(directory?: string): Record<string, { type: "busy" }> {
  const result: Record<string, { type: "busy" }> = {};
  for (const runtime of Registry.all()) {
    if (directory !== undefined && runtime.cwd !== directory) continue;
    if (statusOfState(runtime.state) === "busy") result[runtime.sessionId] = { type: "busy" };
    for (const subagent of runtime.subagents()) {
      if (subagent.status === "running" && subagent.childSessionId) result[subagent.childSessionId] = { type: "busy" };
    }
  }
  return result;
}

/** `/session/status`: driven sessions, their children, and sessions followed in another omp. Idle sessions are absent. */
export function sessionStatusMap(directory?: string): Record<string, { type: string }> {
  return { ...followedStatuses(directory), ...drivenStatuses(directory) };
}

export interface JobFilter {
  sessionID?: string;
  kind?: string;
  status?: string;
  descendants?: boolean;
}

/** `/experimental/job`: background work running in driven sessions (subagents, async jobs). */
export async function listJobs(filter: JobFilter): Promise<BackgroundJob[]> {
  if (filter.status && filter.status !== "running") return [];
  const all = (await Promise.all(Registry.all().map((runtime) => runtime.jobs().catch(() => [])))).flat();
  return all.filter((job) => {
    if (filter.kind && job.kind !== filter.kind) return false;
    if (!filter.sessionID) return true;
    if (job.sessionID === filter.sessionID) return true;
    // A subagent's own jobs run in its parent's process: descendants of a child are the parent's jobs under it.
    return filter.descendants === true && job.childSessionID === filter.sessionID;
  });
}
