/**
 * Read-only "follow" of a session another omp (typically a terminal) owns.
 *
 * Such a session cannot be driven from here, but its transcript is still the
 * truth: omp appends a message to the JSONL as soon as it completes. A followed
 * session is polled by file stamp; each growth is turned into the same events a
 * live turn would have produced (user message, step, text/reasoning/tool parts,
 * busy/idle) so OpenChamber shows the terminal's work as it lands. The grain is
 * one message, not one token: omp streams tokens only to its own process.
 *
 * Followed from the moment a client reads the session's messages. A session the
 * sidecar itself drives (it has a live child) is never emitted from here.
 */
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
import { isSessionDriven, sessionOwnedElsewhere } from "./prompt";
import { stat } from "node:fs/promises";

const POLL_MS = Number(process.env.OC_FOLLOW_POLL_MS ?? 750);
/** A followed session with no new messages for this long stops being polled (re-followed on the next read). */
const EXPIRE_MS = 30 * 60_000;
/** A session that looks busy but has had no new messages is checked for a live owner this often. */
const OWNER_CHECK_MS = Number(process.env.OC_FOLLOW_OWNER_CHECK_MS ?? 30_000);

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
  busy: boolean;
  lastGrowth: number;
  lastOwnerCheck: number;
  ticking: boolean;
  /** Signature of the message set last applied; only a change here counts as progress. */
  messagesKey: string | null;
}

const followed = new Map<string, Followed>();
let timer: ReturnType<typeof setInterval> | undefined;

const keyOf = (id: string, cwd: string) => `${id}\0${cwd}`;

/** Start (or keep) following a session. Cheap to call on every read. */
export function followSession(id: string, cwd: string, path: string): void {
  const key = keyOf(id, cwd);
  const existing = followed.get(key);
  if (existing) {
    existing.path = path;
    return;
  }
  followed.set(key, { id, cwd, path, seen: null, messagesKey: null, busy: false, lastGrowth: Date.now(), lastOwnerCheck: 0, ticking: false });
  timer ??= setInterval(() => void tickAll(), POLL_MS);
  timer.unref?.();
}

/** Sessions currently believed busy in another omp, for `/session/status`. */
export function followedStatuses(directory?: string): Record<string, { type: string }> {
  const result: Record<string, { type: string }> = {};
  for (const entry of followed.values()) {
    if (entry.busy && (directory === undefined || entry.cwd === directory)) result[entry.id] = { type: "busy" };
  }
  return result;
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

function isBusy(records: OpenCodeMessageRecord[]): boolean {
  const last = records.at(-1);
  if (!last) return false;
  if (last.info.role === "user") return true;
  if (last.info.role !== "assistant") return false;
  if (last.parts.some((part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"))) return true;
  return last.info.finish === "toolUse" || last.info.finish === "tool-calls" || last.info.finish === "tool_calls";
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
      entry.messagesKey = null;
      entry.busy = false;
      entry.stamp = undefined;
      entry.lastGrowth = Date.now();
      return;
    }
    const stamp = await stampOf(entry.path);
    const now = Date.now();
    if (stamp !== entry.stamp || !entry.seen) {
      entry.stamp = stamp;
      const records = await backendForSession(entry.id).store.transcript?.(entry.id, entry.cwd);
      if (records && applyTranscript(entry, records, now)) {
        entry.lastOwnerCheck = now;
        if (await sessionOwnedElsewhere(entry.id, entry.cwd, entry.path)) setBusy(entry, true);
      }
    }
    // Progress is a new message, never file growth: metadata appends must not keep a dead turn busy.
    if (entry.busy && now - entry.lastGrowth > OWNER_CHECK_MS && now - entry.lastOwnerCheck > OWNER_CHECK_MS) {
      entry.lastOwnerCheck = now;
      if (!(await sessionOwnedElsewhere(entry.id, entry.cwd, entry.path))) setBusy(entry, false);
    } else if (entry.seen && !entry.busy && now - entry.lastGrowth > EXPIRE_MS) {
      followed.delete(keyOf(entry.id, entry.cwd));
    }
  } finally {
    entry.ticking = false;
  }
}

/**
 * Applies one transcript read: emits message deltas and recomputes busy when the message set changed.
 * Returns true for a cold read ending mid-turn, whose busy state is left for the caller to settle.
 */
function applyTranscript(entry: Followed, records: OpenCodeMessageRecord[], now: number): boolean {
  const ordered = [...records].sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0));
  const messagesKey = ordered.map((record) => `${record.info.id}\0${signatureOf(record)}`).join("\n");
  const changed = messagesKey !== entry.messagesKey;
  const baseline = entry.seen === null;
  entry.messagesKey = messagesKey;
  entry.seen ??= new Map();
  if (!baseline && changed) entry.lastGrowth = now;
  let emittedAny = false;
  for (const record of ordered) {
    if (baseline) {
      entry.seen.set(record.info.id, { signature: signatureOf(record), started: true, ended: true, announcedTools: new Set() });
      continue;
    }
    if (emitRecord(entry, record)) emittedAny = true;
  }
  if (!baseline) emitSessionUpdated({ id: entry.id, time: { updated: now } }, entry.cwd);
  if (!changed) return false;
  const busy = isBusy(ordered);
  // Read cold, a tail that ends mid-turn is as likely a dead child's leftovers as a live terminal
  // turn. Nothing here can tell which, so the caller asks the owner before declaring it busy.
  if (baseline) return busy;
  // A whole turn can land between two polls: still bracket it with busy → idle.
  if (!busy && !entry.busy && emittedAny) setBusy(entry, true);
  setBusy(entry, busy);
  return false;
}

function setBusy(entry: Followed, busy: boolean): void {
  if (entry.busy === busy) return;
  entry.busy = busy;
  emitSessionStatus(entry.id, { type: busy ? "busy" : "idle" }, entry.cwd);
  if (!busy) emitSessionIdle(entry.id, entry.cwd);
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
