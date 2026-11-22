/**
 * omp's context numbers as the transcript records them.
 *
 * Every settled assistant entry carries provider-reported `usage` and, since
 * omp tracks anchors, a `contextSnapshot`. Reading them offline gives the same
 * `used` figure omp's status line shows, with no re-estimation. Category
 * attribution (skills, tools, …) is not in the transcript; it needs omp's
 * `get_context_breakdown` RPC (see `breakdown`).
 */
import type { OpenCodeMessageRecord, OpenCodeProvidersResponse, TokenBreakdown } from "../shared/types";

/** One point on a session's context curve: the prompt omp sent for one assistant message. */
export interface OmpContextPoint {
  /** Prompt tokens in context after local history rewrites. */
  used: number;
  /** The model's context window, when the sidecar has seen the model list. */
  window?: number;
  /** Estimated non-message share of `used` (system prompt, tools, instruction files). */
  nonMessage?: number;
  /** Estimated tool-schema share of `nonMessage`. */
  toolSchema?: number;
  cacheRead: number;
  cacheWrite: number;
  /** Compaction epoch the request was recorded in. */
  compactionEpoch?: number;
  /** Unix milliseconds the message was created. */
  at: number;
}

const windows = new Map<string, number>();

/** Remembers each model's context window from a model list so transcripts can report fill. */
export function rememberModelWindows(response: OpenCodeProvidersResponse): void {
  for (const provider of response.providers) {
    for (const [modelID, model] of Object.entries(provider.models ?? {})) {
      const context = model.limit?.context;
      if (typeof context === "number" && context > 0) windows.set(`${provider.id}/${modelID}`, context);
    }
  }
}

export function modelWindow(providerID: string, modelID: string): number | undefined {
  return windows.get(`${providerID}/${modelID}`);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The context point of one assistant message, or `undefined` when the provider
 * reported no prompt size (aborted before the first byte, compaction entries).
 */
export function contextPointOfMessage(
  snapshot: unknown,
  tokens: TokenBreakdown,
  providerID: string,
  modelID: string,
  at: number,
): OmpContextPoint | undefined {
  const snap = snapshot && typeof snapshot === "object" ? snapshot as Record<string, unknown> : undefined;
  const prompt = finite(snap?.promptTokens) ?? tokens.input + tokens.cache.read + tokens.cache.write;
  if (prompt <= 0) return undefined;
  const used = Math.max(0, prompt - (finite(snap?.historyRewriteTokensRemoved) ?? 0));
  const window = modelWindow(providerID, modelID);
  const nonMessage = finite(snap?.nonMessageTokens);
  const toolSchema = finite(snap?.toolSchemaTokens);
  const epoch = finite(snap?.compactionEpoch);
  return {
    used,
    ...(window !== undefined ? { window } : {}),
    ...(nonMessage !== undefined ? { nonMessage } : {}),
    ...(toolSchema !== undefined ? { toolSchema } : {}),
    cacheRead: tokens.cache.read,
    cacheWrite: tokens.cache.write,
    ...(epoch !== undefined ? { compactionEpoch: epoch } : {}),
    at,
  };
}

/** Context curve of a session: every assistant record that carries a point, oldest first. */
export function contextHistory(records: OpenCodeMessageRecord[]): OmpContextPoint[] {
  const points: OmpContextPoint[] = [];
  for (const record of records) {
    const omp = record.info.metadata?.omp;
    const context = omp && typeof omp === "object" ? (omp as { context?: OmpContextPoint }).context : undefined;
    if (context) points.push(context);
  }
  return points.sort((a, b) => a.at - b.at);
}

/** Published on `metadata.openchamber.context`: the newest point, flattened for guests. */
export interface OmpSessionContext {
  used: number;
  window?: number;
  nonMessage?: number;
  updatedAt: number;
}

export function sessionContextOf(history: OmpContextPoint[]): OmpSessionContext | undefined {
  const last = history[history.length - 1];
  if (!last) return undefined;
  return {
    used: last.used,
    ...(last.window !== undefined ? { window: last.window } : {}),
    ...(last.nonMessage !== undefined ? { nonMessage: last.nonMessage } : {}),
    updatedAt: last.at,
  };
}
