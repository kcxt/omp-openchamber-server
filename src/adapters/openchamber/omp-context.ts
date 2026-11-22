/**
 * `GET /api/omp/context/:sessionId?directory=&breakdown=1`: omp's context map for one session.
 *
 * Tier 1 comes from the transcript (`metadata.omp.context` on every assistant
 * message): window fill, the history curve, cache weight, compactions. The
 * per-category `breakdown` comes from `omp session inspect`, which costs one
 * read-only omp spawn unless the session's first read already prefetched it,
 * so it is opt-in and degrades to `null` when omp cannot answer.
 */
import {
  contextHistory,
  sessionContextOf,
  type OmpContextPoint,
  type OmpSessionContext,
} from "../../omp/context";
import { OmpCli } from "../../omp/cli";
import { loadSessionMessages } from "../../omp/messages";
import type { OpenCodeMessageRecord, OpenCodeSession } from "../../shared/types";

export const OMP_CONTEXT_VERSION = 1;

export interface OmpContextBreakdown {
  /** omp's own categories: systemPrompt, systemTools, systemContext, instructionFiles, skills, messages. */
  categories: Record<string, number>;
  usedTokens?: number;
  contextWindow?: number;
  thresholdTokens?: number;
  autoCompactBufferTokens?: number;
  freeTokens?: number;
  [key: string]: unknown;
}

export interface OmpContextResponse {
  version: typeof OMP_CONTEXT_VERSION;
  sessionId: string;
  /** Newest point, or `null` before the first assistant reply. */
  current: OmpSessionContext | null;
  history: OmpContextPoint[];
  cache: { read: number; write: number; lastTurnRead: number; lastTurnWrite: number };
  compactions: { count: number; lastAt?: number; tokensBefore?: number; tokensAfter?: number };
  breakdown: OmpContextBreakdown | null;
}

function compactionsOf(records: OpenCodeMessageRecord[]): OmpContextResponse["compactions"] {
  let count = 0;
  let last: OpenCodeMessageRecord | undefined;
  for (const record of records) {
    if (record.info.role !== "assistant" || record.info.summary !== true) continue;
    count++;
    last = record;
  }
  if (!last) return { count };
  return {
    count,
    lastAt: last.info.time?.created,
    tokensBefore: last.info.tokens?.input,
    tokensAfter: last.info.tokens?.output,
  };
}

export function buildOmpContext(
  sessionId: string,
  records: OpenCodeMessageRecord[],
  breakdown: OmpContextBreakdown | null,
): OmpContextResponse {
  const history = contextHistory(records);
  const last = history[history.length - 1];
  return {
    version: OMP_CONTEXT_VERSION,
    sessionId,
    current: sessionContextOf(history) ?? null,
    history,
    cache: {
      read: history.reduce((sum, point) => sum + point.cacheRead, 0),
      write: history.reduce((sum, point) => sum + point.cacheWrite, 0),
      lastTurnRead: last?.cacheRead ?? 0,
      lastTurnWrite: last?.cacheWrite ?? 0,
    },
    compactions: compactionsOf(records),
    breakdown,
  };
}

/** omp's categorical breakdown for the session (read-only `omp session inspect`, usually prefetched), or `null` when omp has none. */
async function readBreakdown(session: OpenCodeSession): Promise<OmpContextBreakdown | null> {
  try {
    const inspection = await OmpCli.inspect(session.path, session.directory);
    return inspection.contextBreakdown as OmpContextBreakdown | null;
  } catch {
    return null;
  }
}

export async function loadOmpContext(
  session: OpenCodeSession,
  options: { breakdown: boolean },
): Promise<OmpContextResponse> {
  const records = (await loadSessionMessages(session.id, session.directory)) ?? [];
  const breakdown = options.breakdown ? await readBreakdown(session) : null;
  return buildOmpContext(session.id, records, breakdown);
}

/** `metadata.openchamber.context` for a single session; sessions with no context point are returned unchanged. */
export async function attachOmpSessionContext(session: OpenCodeSession): Promise<OpenCodeSession> {
  const records = (await loadSessionMessages(session.id, session.directory).catch(() => null)) ?? [];
  const context = sessionContextOf(contextHistory(records));
  if (!context) return session;
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const openchamber = (metadata.openchamber ?? {}) as Record<string, unknown>;
  return { ...session, metadata: { ...metadata, openchamber: { ...openchamber, context } } };
}
