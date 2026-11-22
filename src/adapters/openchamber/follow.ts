/**
 * Read-only "follow" of a session another omp (typically a terminal) owns.
 *
 * Such a session cannot be driven from here, but its transcript is still the
 * truth: omp appends a message to the JSONL as soon as it completes. A followed
 * session is polled by file stamp; each growth is turned into the same events a
 * live turn would have produced (user message, step, text/reasoning/tool parts)
 * so OpenChamber shows the terminal's work as it lands. The grain is one
 * message, not one token: omp streams tokens only to its own process.
 *
 * Busy/idle is `statusOf` (lease first, tail second), re-evaluated whenever the
 * stamp changes and, while the answer is not "idle", at a slow interval: the
 * lease can drop without the file changing. An event goes out when that answer
 * changes. What was last published is output dedupe, never a decision input.
 *
 * Followed from the moment a client reads the session's messages. A session the
 * sidecar itself drives (it has a live child) is never emitted from here.
 */
import { OmpCli } from "../../omp/cli";
import { backendForSession } from "../../providers/registry";
import type { OpenCodeMessageRecord } from "../../providers/types";
import { logger } from "../../shared/logger";
import {
  emitMessagePartUpdated,
  emitMessageUpdated,
  emitOpenCodeV2Event,
  emitSessionIdle,
  emitSessionStatus,
  emitSessionUpdated,
} from "../../shared/sse";
import { isSessionDriven, statusOf, type SessionStatus } from "../../sessions/status";
import { stat } from "node:fs/promises";

const POLL_MS = Number(process.env.OC_FOLLOW_POLL_MS ?? 750);
/** A followed session OpenChamber has not read for this long, with no lease holder, stops being polled (re-followed on the next read). */
const EXPIRE_MS = 30 * 60_000;
/** A busy or unknown session is re-evaluated this often even when its transcript is unchanged. */
const RECHECK_MS = Number(process.env.OC_FOLLOW_RECHECK_MS ?? 15_000);

interface SeenMessage {
  signature: string;
  started: boolean;
  ended: boolean;
  /** Tool parts already announced as running, so a completed one is not the first the UI hears of. */
  announcedTools: Set<string>;
}

interface Followed {
  id: string;
  cwd: string;
  path: string;
  stamp?: string;
  seen: Map<string, SeenMessage> | null;
  /** Latest `statusOf` answer, served to `/session/status` and `/session/active`. */
  status: SessionStatus;
  /** The busy/idle last published to OpenChamber. */
  published: "busy" | "idle";
  evaluatedAt: number;
  lastRead: number;
  ticking: boolean;
}

const followed = new Map<string, Followed>();
let timer: ReturnType<typeof setInterval> | undefined;

const keyOf = (id: string, cwd: string) => `${id}\0${cwd}`;

/**
 * Start (or keep) following a session. Cheap to call on every read. The first
 * read of a session no runtime drives also starts omp's read-only inspection
 * in the background, so the context panel usually answers from its memo.
 */
export function followSession(id: string, cwd: string, path: string): void {
  const key = keyOf(id, cwd);
  const existing = followed.get(key);
  if (existing) {
    existing.path = path;
    existing.lastRead = Date.now();
    return;
  }
  followed.set(key, { id, cwd, path, seen: null, status: "idle", published: "idle", evaluatedAt: 0, lastRead: Date.now(), ticking: false });
  timer ??= setInterval(() => void tickAll(), POLL_MS);
  timer.unref?.();
  if (!isSessionDriven(id, cwd)) {
    OmpCli.inspect(path, cwd).catch((err) => logger.debug({ err, sessionID: id }, "[follow] inspect prefetch failed"));
  }
}

/** Sessions currently busy in another omp, for `/session/status`. */
export function followedStatuses(directory?: string): Record<string, { type: string }> {
  const result: Record<string, { type: string }> = {};
  for (const entry of followed.values()) {
    if (entry.status === "busy" && (directory === undefined || entry.cwd === directory)) result[entry.id] = { type: "busy" };
  }
  return result;
}

/** Followed sessions whose latest status probe failed. */
export function unknownFollowed(directory?: string): string[] {
  return [...followed.values()]
    .filter((entry) => entry.status === "unknown" && (directory === undefined || entry.cwd === directory))
    .map((entry) => entry.id);
}

export function stopFollowingAll(): void {
  followed.clear();
  if (timer) clearInterval(timer);
  timer = undefined;
}

async function tickAll(): Promise<void> {
  await Promise.all([...followed.values()].map((entry) => tick(entry).catch((err) => {
    logger.debug({ err, sessionID: entry.id }, "[follow] tick failed");
  })));
  if (followed.size === 0 && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

async function stampOf(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return undefined;
  }
}

function signatureOf(record: OpenCodeMessageRecord): string {
  const parts = record.parts.map((part) => (
    part.type === "tool" ? [part.id, part.state.status, part.state.output?.length ?? 0] : [part.id, part.type, "text" in part ? part.text.length : 0]
  ));
  return JSON.stringify([parts, record.info.finish ?? null]);
}

async function tick(entry: Followed): Promise<void> {
  if (entry.ticking) return;
  entry.ticking = true;
  try {
    if (isSessionDriven(entry.id, entry.cwd)) {
      // The sidecar's own child emits this session now; re-read the baseline when it lets go.
      entry.seen = null;
      entry.stamp = undefined;
      entry.status = "idle";
      entry.published = "idle";
      entry.evaluatedAt = 0;
      return;
    }
    const stamp = await stampOf(entry.path);
    let emitted = false;
    let evaluate = false;
    if (stamp !== entry.stamp || !entry.seen) {
      entry.stamp = stamp;
      const records = await backendForSession(entry.id).store.transcript?.(entry.id, entry.cwd);
      if (records) emitted = applyTranscript(entry, records, Date.now());
      evaluate = true;
    } else if (entry.status !== "idle" && Date.now() - entry.evaluatedAt >= RECHECK_MS) {
      evaluate = true;
    }
    if (evaluate) {
      entry.status = await statusOf(entry.id, entry.cwd, entry.path);
      entry.evaluatedAt = Date.now();
      publish(entry, emitted);
    }
    if (entry.status === "idle" && Date.now() - entry.lastRead > EXPIRE_MS) followed.delete(keyOf(entry.id, entry.cwd));
  } finally {
    entry.ticking = false;
  }
}

/** Emits the message deltas one transcript read produced; whether any went out. The first read is the silent baseline. */
function applyTranscript(entry: Followed, records: OpenCodeMessageRecord[], now: number): boolean {
  const ordered = [...records].sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0));
  const baseline = entry.seen === null;
  entry.seen ??= new Map();
  let emittedAny = false;
  for (const record of ordered) {
    if (baseline) {
      entry.seen.set(record.info.id, { signature: signatureOf(record), started: true, ended: true, announcedTools: new Set() });
      continue;
    }
    if (emitRecord(entry, record)) emittedAny = true;
  }
  if (!baseline) emitSessionUpdated({ id: entry.id, time: { updated: now } }, entry.cwd);
  return emittedAny;
}

/** Publishes a change of the busy/idle answer; `unknown` publishes nothing (it is not idle, and not provably busy). */
function publish(entry: Followed, emittedMessages: boolean): void {
  if (entry.status === "unknown") return;
  // A whole turn can land between two polls: still bracket it with busy → idle.
  if (entry.status === "idle" && emittedMessages && entry.published === "idle") setPublished(entry, "busy");
  setPublished(entry, entry.status);
}

function setPublished(entry: Followed, status: "busy" | "idle"): void {
  if (entry.published === status) return;
  entry.published = status;
  emitSessionStatus(entry.id, { type: status }, entry.cwd);
  if (status === "idle") emitSessionIdle(entry.id, entry.cwd);
}

/** Emits what changed in one record; whether anything was sent. */
function emitRecord(entry: Followed, record: OpenCodeMessageRecord): boolean {
  const { id: sessionID, cwd } = entry;
  const seen = entry.seen!;
  const signature = signatureOf(record);
  const previous = seen.get(record.info.id);
  if (previous?.signature === signature) return false;
  const state: SeenMessage = previous ?? { signature, started: false, ended: false, announcedTools: new Set() };
  state.signature = signature;
  seen.set(record.info.id, state);

  if (record.info.role === "user") {
    if (state.started) return false;
    state.started = true;
    state.ended = true;
    const text = record.parts.flatMap((part) => (part.type === "text" && part.synthetic !== true ? [part.text] : [])).join("\n\n");
    emitOpenCodeV2Event("session.inbox.enqueued", {
      sessionID,
      inboxID: record.info.id,
      item: { type: "user", delivery: "queue", payload: { text, files: [] } },
    }, cwd);
    emitMessageUpdated({ info: record.info }, cwd);
    for (const part of record.parts) emitMessagePartUpdated(sessionID, { ...part }, cwd);
    emitOpenCodeV2Event("session.inbox.delivered", { sessionID, inboxID: record.info.id }, cwd);
    return true;
  }

  if (record.info.role !== "assistant") return false;
  if (!state.started) {
    state.started = true;
    const { finish: _finish, error: _error, ...open } = record.info;
    emitMessageUpdated({ info: { ...open, time: { created: record.info.time.created } } }, cwd);
  }
  for (const part of record.parts) {
    if (part.type === "tool") {
      if (part.state.status === "completed" || part.state.status === "error") {
        if (!state.announcedTools.has(part.id)) {
          emitMessagePartUpdated(sessionID, { ...part, state: { ...part.state, status: "running", output: undefined, error: undefined } }, cwd);
        }
        emitMessagePartUpdated(sessionID, { ...part }, cwd);
      } else {
        emitMessagePartUpdated(sessionID, { ...part }, cwd);
      }
      state.announcedTools.add(part.id);
    } else if (part.type === "text" || part.type === "reasoning") {
      const start = part.time?.start ?? record.info.time.created;
      emitMessagePartUpdated(sessionID, { ...part, time: { start, end: part.time?.end ?? start } }, cwd);
    } else {
      emitMessagePartUpdated(sessionID, { ...part }, cwd);
    }
  }
  if (record.info.finish !== undefined && !state.ended) {
    state.ended = true;
    emitMessageUpdated({ info: record.info }, cwd);
  }
  return true;
}
