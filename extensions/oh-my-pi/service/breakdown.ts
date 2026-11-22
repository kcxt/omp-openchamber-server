import type { SidecarReason } from './sidecar';

// Reduction of the sidecar's `GET /api/omp/context/:sessionId?breakdown=1` answer
// (src/adapters/openchamber/omp-context.ts) into what the tab draws.
//
// Exact figures, from the transcript: `current.used` (the provider-reported prompt size), the
// model window, cache read/write, the history curve, compactions. omp's own estimates, from
// `omp session inspect`: the per-category totals and the compaction buffer. Without those, the
// transcript's `nonMessage` / `toolSchema` split gives three coarse categories.

/** What omp's `/context` names, in its order, plus the transcript-only split used when omp cannot answer. */
export type CategoryId =
  | 'systemPrompt'
  | 'systemTools'
  | 'systemContext'
  | 'instructionFiles'
  | 'skills'
  | 'system'
  | 'messages'
  | 'free';

export type Category = { id: CategoryId; tokens: number };

/** Why a session could not be read; the page words it. */
export type NotFoundReason = SidecarReason | 'no-window';

export type ContextReport =
  | {
      status: 'ok';
      model: string | null;
      limit: number;
      total: number;
      cacheRead: number;
      cacheWrite: number;
      categories: Category[];
      /** `true` when the categories are omp's own; `false` for the transcript-only split. */
      categoriesFromOmp: boolean;
      history: number[];
      compaction: { threshold: number | null; buffer: number | null; growth: number | null; count: number; tokensBefore: number | null; tokensAfter: number | null };
      cache: { lastTurnAt: number | null; ttlMs: number };
    }
  | { status: 'no-turn' }
  | { status: 'not-found'; reason: NotFoundReason };

/** The fields of the sidecar's answer this tab reads. */
export type SidecarContext = {
  current: { used: number; window?: number; nonMessage?: number; updatedAt: number } | null;
  history: Array<{ used: number; at: number; cacheRead: number; cacheWrite: number; nonMessage?: number; toolSchema?: number }>;
  cache: { read: number; write: number; lastTurnRead: number; lastTurnWrite: number };
  compactions: { count: number; lastAt?: number; tokensBefore?: number; tokensAfter?: number };
  breakdown: {
    model?: { provider?: string; modelId?: string };
    contextWindow?: number;
    categories?: Array<{ id: string; tokens: number }>;
    thresholdTokens?: number;
    autoCompactBufferTokens?: number;
  } | null;
};

const HISTORY_POINTS = 40;
/** Growth is averaged over the last calls: the start of a session says little about now. */
const GROWTH_WINDOW = 10;
/** omp does not report the provider's cache lifetime; Anthropic's default is the common case. */
export const CACHE_TTL_MS = 5 * 60_000;

const OMP_CATEGORIES: CategoryId[] = ['systemPrompt', 'systemTools', 'systemContext', 'instructionFiles', 'skills', 'messages'];

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

export function buildReport(context: SidecarContext): ContextReport {
  const { current, breakdown } = context;
  if (!current) return { status: 'no-turn' };

  const limit = num(breakdown?.contextWindow) ?? num(current.window);
  if (!limit) return { status: 'not-found', reason: 'no-window' };
  const total = current.used;

  const omp = (breakdown?.categories ?? []).filter((category): category is { id: CategoryId; tokens: number } =>
    OMP_CATEGORIES.includes(category.id as CategoryId) && num(category.tokens) !== undefined);
  const categories: Category[] = omp.length > 0 ? omp.map(({ id, tokens }) => ({ id, tokens })) : transcriptCategories(context);

  const buffer = num(breakdown?.autoCompactBufferTokens) ?? null;
  const threshold = num(breakdown?.thresholdTokens) ?? (buffer === null ? null : limit - buffer);
  const model = breakdown?.model?.provider && breakdown.model.modelId ? `${breakdown.model.provider}/${breakdown.model.modelId}` : null;
  const last = context.history.at(-1);

  return {
    status: 'ok',
    model,
    limit,
    total,
    cacheRead: context.cache.lastTurnRead,
    cacheWrite: context.cache.lastTurnWrite,
    categories,
    categoriesFromOmp: omp.length > 0,
    history: context.history.slice(-HISTORY_POINTS).map((point) => point.used),
    compaction: {
      threshold,
      buffer,
      growth: averageGrowth(context.history.map((point) => point.used)),
      count: context.compactions.count,
      tokensBefore: num(context.compactions.tokensBefore) ?? null,
      tokensAfter: num(context.compactions.tokensAfter) ?? null,
    },
    // A turn that touched the cache is the only one a lifetime means anything for.
    cache: { lastTurnAt: last && (last.cacheRead > 0 || last.cacheWrite > 0) ? last.at : null, ttlMs: CACHE_TTL_MS },
  };
}

/** The coarse split the transcript carries when omp has no category totals. */
function transcriptCategories({ current, history }: SidecarContext): Category[] {
  if (!current) return [];
  const nonMessage = Math.min(current.nonMessage ?? 0, current.used);
  if (nonMessage === 0) return [{ id: 'messages', tokens: current.used }];
  const toolSchema = Math.min(num(history.at(-1)?.toolSchema) ?? 0, nonMessage);
  return [
    { id: 'system', tokens: nonMessage - toolSchema },
    ...(toolSchema > 0 ? [{ id: 'systemTools' as const, tokens: toolSchema }] : []),
    { id: 'messages', tokens: current.used - nonMessage },
  ];
}

/** Mean growth per model call over the last calls, ignoring the drops a compaction makes. */
function averageGrowth(used: number[]): number | null {
  const recent = used.slice(-(GROWTH_WINDOW + 1));
  const deltas = recent.slice(1).map((value, index) => value - recent[index]!).filter((delta) => delta > 0);
  if (deltas.length === 0) return null;
  return Math.round(deltas.reduce((total, delta) => total + delta, 0) / deltas.length);
}
