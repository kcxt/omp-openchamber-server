/**
 * omp's own idle recap, published where OpenChamber's session-assist UI reads it.
 *
 * omp generates a recap when a session has been quiet for `recap.idleSeconds`
 * (`recap.enabled`, default on) and journals it to `session_recaps` in
 * `~/.omp/agent/history.db`. OpenChamber's own recap path runs its Small Model
 * and deliberately skips a session whose model is a local endpoint, so an
 * omp-backed session never gets one from OpenChamber. The slot is the same
 * either way: `metadata.openchamber.assist`.
 *
 * The client requires a non-empty `forMessageID` to render the recap, so the
 * assistant message id is rebuilt from the last user prompt the sidecar
 * recorded — the same id the transcript mapper and the live turn handler mint.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getDefaultHistoryDbPath, listPersistedMessageIds } from "./title-db";
import { timeHexFromTimestamp, timeHexOfMessageId } from "../../shared/message-id";
import type { OpenCodeSession } from "../types";

const RECAP_TTL_MS = 30_000;
/** OpenChamber's own assist caps a recap at this many characters. */
const RECAP_CHAR_LIMIT = 320;
const OMP_UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.\w+)*$/;

export interface OmpRecap {
  recap: string;
  /** Unix milliseconds. */
  generatedAt: number;
}

interface RecapRow {
  session_id: string;
  recap: string;
  created_at: number;
}

let db: Database | undefined;
let dbUnavailable = false;
const cache = new Map<string, { readAt: number; recap: OmpRecap | null }>();

function recapIndex(): Database | undefined {
  if (dbUnavailable) return undefined;
  if (!db) {
    try {
      db = new Database(getDefaultHistoryDbPath(), { readonly: true });
    } catch {
      dbUnavailable = true;
      return undefined;
    }
  }
  return db;
}

/** The newest journaled recap per omp session id, reading only cache misses. */
function latestRecaps(sessionIds: string[]): Map<string, OmpRecap> {
  const now = Date.now();
  const found = new Map<string, OmpRecap>();
  const missing: string[] = [];
  for (const id of sessionIds) {
    const hit = cache.get(id);
    if (hit && now - hit.readAt < RECAP_TTL_MS) {
      if (hit.recap) found.set(id, hit.recap);
      continue;
    }
    missing.push(id);
  }
  if (missing.length === 0) return found;

  const index = recapIndex();
  let rows: RecapRow[] = [];
  if (index) {
    try {
      const placeholders = missing.map(() => "?").join(", ");
      rows = index.query(
        `SELECT session_id, recap, created_at FROM session_recaps
         WHERE typeof(recap) = 'text' AND typeof(created_at) = 'integer'
           AND session_id IN (${placeholders})
         ORDER BY created_at DESC, id DESC`,
      ).all(...missing) as RecapRow[];
    } catch {
      // No journal yet (no omp session has been idle long enough), or the
      // table is missing in an older history.db.
    }
  }

  const bySession = new Map<string, OmpRecap>();
  for (const row of rows) {
    if (bySession.has(row.session_id)) continue;
    const text = typeof row.recap === "string" ? row.recap.trim() : "";
    if (!text) continue;
    bySession.set(row.session_id, {
      recap: text,
      generatedAt: (typeof row.created_at === "number" ? row.created_at : 0) * 1000,
    });
  }
  for (const id of missing) {
    const recap = bySession.get(id) ?? null;
    cache.set(id, { readAt: now, recap });
    if (recap) found.set(id, recap);
  }
  return found;
}

/** omp's session id, which is the UUID in the transcript file name. */
function ompSessionId(session: OpenCodeSession): string | undefined {
  if (!session.path) return undefined;
  return basename(session.path).match(OMP_UUID_AT_END)?.[1];
}

/**
 * The assistant message a recap summarizes: `msg_<session>_asst_<last prompt>`,
 * which is how both the transcript mapper and the live turn handler name the
 * assistant turn following a user message.
 */
function recapSubjectMessageID(session: OpenCodeSession): string | undefined {
  const recorded = listPersistedMessageIds(session.id);
  let newest: { clientMessageId: string; createdAt: number } | undefined;
  for (const item of recorded) {
    if (!newest || item.createdAt > newest.createdAt) newest = item;
  }
  if (!newest) return undefined;
  const asstHex = timeHexOfMessageId(newest.clientMessageId) ?? timeHexFromTimestamp(newest.createdAt);
  return `msg_${asstHex}~${session.id}_asst_${newest.clientMessageId}`;
}

const hasAssist = (session: OpenCodeSession): boolean => {
  const metadata = session.metadata as Record<string, unknown> | undefined;
  const openchamber = metadata?.openchamber as Record<string, unknown> | undefined;
  const assist = openchamber?.assist as Record<string, unknown> | undefined;
  return typeof assist?.recap === "string" && assist.recap.trim().length > 0;
};

/**
 * OpenChamber's own recap toggle. Its session-assist runtime reads
 * `sessionRecapEnabled` (default on) from the same settings file, so the side
 * car publishes omp's recap only while that feature is on.
 */
let openchamberGate: { readAt: number; enabled: boolean } | undefined;

function openchamberRecapEnabled(): boolean {
  const now = Date.now();
  if (openchamberGate && now - openchamberGate.readAt < RECAP_TTL_MS) return openchamberGate.enabled;
  let enabled = true;
  try {
    const file = join(
      process.env.OPENCHAMBER_DATA_DIR ? resolve(process.env.OPENCHAMBER_DATA_DIR) : join(homedir(), ".config", "openchamber"),
      "settings.json",
    );
    const settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    enabled = settings.sessionRecapEnabled !== false;
  } catch {
    // No settings file yet: OpenChamber's own default is enabled.
  }
  openchamberGate = { readAt: now, enabled };
  return enabled;
}

const withinLimit = (text: string): string =>
  text.length <= RECAP_CHAR_LIMIT ? text : `${text.slice(0, RECAP_CHAR_LIMIT - 1).trimEnd()}…`;

/**
 * Add omp's recap to the session records that carry none. OpenChamber's own
 * assist wins when it has written one; a session with no recorded prompt has
 * no assistant turn to attach a recap to, so it is left alone.
 */
export function attachOmpRecapAssist<T extends OpenCodeSession>(sessions: T[]): T[] {
  if (sessions.length === 0 || !openchamberRecapEnabled()) return sessions;
  const candidates = sessions.filter((session) => !hasAssist(session));
  if (candidates.length === 0) return sessions;

  const ids = new Map<string, string>();
  for (const session of candidates) {
    const ompId = ompSessionId(session);
    if (ompId) ids.set(session.id, ompId);
  }
  if (ids.size === 0) return sessions;

  const recaps = latestRecaps([...new Set(ids.values())]);
  if (recaps.size === 0) return sessions;

  return sessions.map((session) => {
    const ompId = ids.get(session.id);
    const recap = ompId ? recaps.get(ompId) : undefined;
    if (!recap || hasAssist(session)) return session;
    const forMessageID = recapSubjectMessageID(session);
    if (!forMessageID) return session;
    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    const openchamber = (metadata.openchamber ?? {}) as Record<string, unknown>;
    return {
      ...session,
      metadata: {
        ...metadata,
        openchamber: {
          ...openchamber,
          assist: {
            ...((openchamber.assist as Record<string, unknown> | undefined) ?? {}),
            recap: withinLimit(recap.recap),
            suggestion: "",
            forMessageID,
            generatedAt: recap.generatedAt,
          },
        },
      },
    };
  });
}

/**
 * `metadata` with a recap omp just produced (P4 `recap` frame) in
 * `openchamber.assist`, or null when OpenChamber's recap feature is off or no
 * assistant message is known to attach it to. `forMessageID` is the assistant
 * message the runtime last completed; without one it is rebuilt as above.
 */
export function withOmpRecapAssist(
  session: OpenCodeSession,
  recap: string,
  createdAt: number,
  forMessageID: string | undefined,
): Record<string, unknown> | null {
  if (!openchamberRecapEnabled()) return null;
  const subject = forMessageID ?? recapSubjectMessageID(session);
  if (!subject) return null;
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const openchamber = (metadata.openchamber ?? {}) as Record<string, unknown>;
  return {
    ...metadata,
    openchamber: {
      ...openchamber,
      assist: {
        ...((openchamber.assist as Record<string, unknown> | undefined) ?? {}),
        recap: withinLimit(recap),
        suggestion: "",
        forMessageID: subject,
        generatedAt: createdAt,
      },
    },
  };
}

/** Test seam: drop the cached recaps and the database handle. */
export function resetOmpRecapCache(): void {
  cache.clear();
  openchamberGate = undefined;
  db?.close();
  db = undefined;
  dbUnavailable = false;
}
