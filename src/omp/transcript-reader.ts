/**
 * The single parser for omp session JSONL.
 *
 * omp's file is a title slot (first line, fixed width), a `session` header and
 * then a tree of entries (`id`/`parentId`). omp's active leaf is the newest
 * entry that selects itself on replay (`resolveSessionLeafId` in omp's
 * `session-entries.ts`): an entry written off the active branch carries
 * `activeLeafId` and restores the leaf it captured instead. The conversation is
 * the path from that leaf to the root; abandoned branches stay in the file.
 *
 * This module only reads. It never writes omp's files. Results are memoised by
 * `(path, size, mtimeMs)`; any append or rewrite by omp changes the stamp.
 *
 * Retention: transcripts are large (the real corpus is ~2 GB), so the full
 * parse (every entry) is kept only in a byte-bounded LRU, while the small
 * summary (header, title, leaf, model, usage) of every file seen is kept for
 * the life of the process, as the session list needs one per file.
 */
import { stat } from "node:fs/promises";
import { isLowSignalTitleInput } from "../providers/omp/title";
import type { TokenBreakdown } from "../providers/types";

export interface UsageMappingResult {
  tokens: TokenBreakdown;
  cost: number;
}

/** A parsed JSONL record. Tree nodes carry `id` and `parentId`. */
export type TranscriptEntry = Record<string, unknown>;

export interface TranscriptHeader {
  id: string;
  cwd: string;
  /** The header's own title field, overridden by the title slot. */
  title?: string;
  timestamp: string;
  version?: string;
  /** Lineage as written by omp (a fork, a continuation) or by the sidecar for API-created children. */
  parentSession?: string;
  /** Sidecar-written identity fields of a header the sidecar created. */
  agent?: string;
  metadata?: Record<string, unknown>;
  openCodeId?: string;
  openCodeParent?: string;
  /** Model recorded in a sidecar-created header, used only when no entry says otherwise. */
  model?: { providerID: string; modelID: string; variant: string };
}

export interface TranscriptLastModel {
  providerID?: string;
  modelID?: string;
  /** Thinking level from omp's own `thinking_level_change`. */
  thinking?: string;
}

export interface TranscriptSummary {
  header: TranscriptHeader | null;
  /** Title slot (or legacy title entry), else the header's title. */
  title?: string;
  firstUserPrompt?: string;
  /** omp's resolved leaf; null for an empty or cleared session. */
  leafId: string | null;
  lastModel: TranscriptLastModel;
  usage: { tokens?: TokenBreakdown; cost: number };
}

export interface Transcript extends TranscriptSummary {
  /** Every record except the title slot, the header and sidecar lines that no longer belong in a transcript. */
  entries: TranscriptEntry[];
  /** `entries` restricted to the active branch, in file order. */
  activeBranch: TranscriptEntry[];
}

/** Record types the sidecar once appended to omp's transcript (without an `id`). */
export const SIDECAR_RECORD_TYPES: ReadonlySet<string> = new Set([
  "oc_alias",
  "oc_notice",
  "agent_change",
  "model_change",
  "revert_change",
  "metadata",
  "archive",
  "viewed",
]);

/** An id-less sidecar record. omp's own `model_change` and `custom` entries carry an `id`. */
export function isSidecarRecord(entry: TranscriptEntry): boolean {
  return typeof entry.type === "string" && SIDECAR_RECORD_TYPES.has(entry.type) && typeof entry.id !== "string";
}

function firstPositive(...values: unknown[]): number {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

export function mapOmpUsageToTokens(rawUsage: unknown, rawCost?: unknown): UsageMappingResult {
  const fallbackTokens: TokenBreakdown = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };

  if (!rawUsage || typeof rawUsage !== "object") {
    let cost = 0;
    if (typeof rawCost === "number" && Number.isFinite(rawCost)) {
      cost = Math.max(0, rawCost);
    }
    return { tokens: fallbackTokens, cost };
  }

  const u = rawUsage as Record<string, unknown>;

  const promptDetails = (u.prompt_tokens_details && typeof u.prompt_tokens_details === "object")
    ? (u.prompt_tokens_details as Record<string, unknown>)
    : (u.promptTokensDetails && typeof u.promptTokensDetails === "object" ? (u.promptTokensDetails as Record<string, unknown>) : undefined);

  const completionDetails = (u.completion_tokens_details && typeof u.completion_tokens_details === "object")
    ? (u.completion_tokens_details as Record<string, unknown>)
    : (u.completionTokensDetails && typeof u.completionTokensDetails === "object" ? (u.completionTokensDetails as Record<string, unknown>) : undefined);

  const output = firstPositive(
    u.output,
    u.outputTokens,
    u.output_tokens,
    u.completion_tokens,
    u.completionTokens,
  );

  const reasoning = firstPositive(
    u.reasoning,
    u.reasoningTokens,
    u.reasoning_tokens,
    completionDetails?.reasoning_tokens,
    completionDetails?.reasoningTokens,
  );

  const cacheRead = firstPositive(
    u.cacheRead,
    u.cache_read,
    u.cached_tokens,
    u.cachedTokens,
    promptDetails?.cached_tokens,
    promptDetails?.cachedTokens,
    u.cache_read_input_tokens,
    promptDetails?.cache_read_input_tokens,
    u.prompt_cache_hit_tokens,
    promptDetails?.prompt_cache_hit_tokens,
  );

  const cacheWrite = firstPositive(
    u.cacheWrite,
    u.cache_write,
    u.cache_write_tokens,
    u.cacheWriteTokens,
    promptDetails?.cache_write_tokens,
    promptDetails?.cacheWriteTokens,
    u.created_cache_tokens,
    u.createdCacheTokens,
    promptDetails?.created_cache_tokens,
    promptDetails?.createdCacheTokens,
    u.cache_creation_input_tokens,
    promptDetails?.cache_creation_input_tokens,
    u.prompt_cache_miss_tokens,
    promptDetails?.prompt_cache_miss_tokens,
  );

  const input = typeof u.input === "number" && Number.isFinite(u.input)
    ? Math.max(0, u.input)
    : (typeof u.inputTokens === "number" && Number.isFinite(u.inputTokens)
      ? Math.max(0, u.inputTokens)
      : (typeof u.input_tokens === "number" && Number.isFinite(u.input_tokens)
        ? Math.max(0, u.input_tokens)
        : (typeof u.prompt_tokens === "number" && Number.isFinite(u.prompt_tokens)
          ? Math.max(0, u.prompt_tokens - cacheRead - cacheWrite)
          : (typeof u.promptTokens === "number" && Number.isFinite(u.promptTokens)
            ? Math.max(0, u.promptTokens - cacheRead - cacheWrite)
            : 0))));

  let cost = 0;
  if (typeof rawCost === "number" && Number.isFinite(rawCost)) {
    cost = Math.max(0, rawCost);
  } else if (typeof u.cost === "number" && Number.isFinite(u.cost)) {
    cost = Math.max(0, u.cost);
  } else if (u.cost && typeof u.cost === "object") {
    const c = u.cost as Record<string, unknown>;
    if (typeof c.total === "number" && Number.isFinite(c.total)) {
      cost = Math.max(0, c.total);
    }
  }

  return {
    tokens: {
      input,
      output,
      reasoning,
      cache: {
        read: cacheRead,
        write: cacheWrite,
      },
    },
    cost,
  };
}

const isNode = (entry: TranscriptEntry): boolean =>
  typeof entry.id === "string" && entry.type !== "session" && "parentId" in entry;

/** Leaf selected when replaying one entry (omp `sessionEntryLeafId`). */
function replayLeaf(entry: TranscriptEntry): string | null {
  const captured = entry.activeLeafId;
  if (captured === null || typeof captured === "string") return captured;
  return entry.id as string;
}

/** Active leaf after replaying `nodes` in file order (omp `resolveSessionLeafId`). */
function resolveLeafId(nodes: TranscriptEntry[]): string | null {
  const last = nodes.at(-1);
  if (!last) return null;
  const leaf = replayLeaf(last);
  if (leaf === null || leaf === last.id || nodes.some((node) => node.id === leaf)) return leaf;
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]!;
    if (replayLeaf(node) === node.id) return node.id as string;
  }
  return null;
}

function parseHeader(entry: TranscriptEntry): TranscriptHeader | null {
  if (entry.type !== "session" || typeof entry.id !== "string" || typeof entry.cwd !== "string") return null;
  const parent = typeof entry.parentSession === "string"
    ? entry.parentSession
    : typeof entry.parentID === "string"
      ? entry.parentID
      : typeof entry.parentId === "string"
        ? entry.parentId
        : undefined;
  return {
    id: entry.id,
    cwd: entry.cwd,
    title: typeof entry.title === "string" && entry.title.trim().length > 0 ? entry.title.trim() : undefined,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
    version: typeof entry.version === "string" ? entry.version : typeof entry.version === "number" ? String(entry.version) : undefined,
    parentSession: parent,
    agent: typeof entry.agent === "string" ? entry.agent : typeof entry.mode === "string" ? entry.mode : undefined,
    metadata: entry.metadata && typeof entry.metadata === "object" ? entry.metadata as Record<string, unknown> : undefined,
    openCodeId: typeof entry.openCodeId === "string" ? entry.openCodeId : undefined,
    openCodeParent: typeof entry.openCodeParent === "string" ? entry.openCodeParent : undefined,
    model: typeof entry.modelId === "string"
      ? {
          providerID: typeof entry.providerID === "string" ? entry.providerID : typeof entry.provider === "string" ? entry.provider : "omp",
          modelID: entry.modelId,
          variant: typeof entry.variant === "string" ? entry.variant : "default",
        }
      : undefined,
  };
}

function promptTextOf(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
        return (block as { text: string }).text;
      }
    }
  }
  return "";
}

/** Pure: omp session JSONL text to its parsed view. A truncated trailing line (omp mid-write) is skipped. */
export function parseTranscript(text: string): Transcript {
  const entries: TranscriptEntry[] = [];
  let header: TranscriptHeader | null = null;
  let title: string | undefined;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: TranscriptEntry;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      header ??= parseHeader(entry);
      continue;
    }
    if (
      (entry.type === "title" || entry.type === "title_change") &&
      typeof entry.title === "string" &&
      typeof entry.id !== "string"
    ) {
      if (entry.title.trim().length > 0) title = entry.title.trim();
      continue;
    }
    if (isSidecarRecord(entry)) continue;
    entries.push(entry);
  }

  const nodes = entries.filter(isNode);
  const leafId = resolveLeafId(nodes);
  let activeBranch = entries;
  if (nodes.length > 0) {
    const byId = new Map<string, TranscriptEntry>();
    for (const node of nodes) byId.set(node.id as string, node);
    const active = new Set<string>();
    for (
      let node = leafId === null ? undefined : byId.get(leafId);
      node && !active.has(node.id as string);
      node = typeof node.parentId === "string" ? byId.get(node.parentId) : undefined
    ) {
      active.add(node.id as string);
    }
    activeBranch = entries.filter((entry) => !isNode(entry) || active.has(entry.id as string));
  }

  let firstUserPrompt: string | undefined;
  let cost = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const message = entry.message as Record<string, unknown>;
      if (message.role === "assistant" && (message.usage || message.cost)) {
        cost += mapOmpUsageToTokens(message.usage, message.cost).cost;
      } else if (!firstUserPrompt && message.role === "user") {
        const promptText = promptTextOf(message);
        if (promptText && !isLowSignalTitleInput(promptText)) firstUserPrompt = promptText.trim();
      }
    } else if (!firstUserPrompt && entry.type === "session_init" && typeof entry.task === "string") {
      const clean = entry.task.replace(/\s+/g, " ").trim();
      if (clean && !isLowSignalTitleInput(clean)) {
        firstUserPrompt = clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
      }
    }
  }

  const lastModel: TranscriptLastModel = {};
  let tokens: TokenBreakdown | undefined;
  for (const entry of activeBranch) {
    if (entry.type === "model_change") {
      // Other roles (smol, slow, ...) are side calls, not the session's model.
      const role = typeof entry.role === "string" ? entry.role : "default";
      const raw = typeof entry.model === "string" ? entry.model : "";
      const slash = raw.indexOf("/");
      if (role === "default" && slash > 0) {
        lastModel.providerID = raw.slice(0, slash);
        lastModel.modelID = raw.slice(slash + 1);
      }
    } else if (entry.type === "thinking_level_change") {
      const level = typeof entry.thinkingLevel === "string"
        ? entry.thinkingLevel
        : typeof entry.configured === "string" ? entry.configured : undefined;
      if (level !== undefined) lastModel.thinking = level;
    } else if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      const message = entry.message as Record<string, unknown>;
      if (message.role !== "assistant") continue;
      if (typeof message.provider === "string" && typeof message.model === "string") {
        lastModel.providerID = message.provider;
        lastModel.modelID = message.model;
      }
      if (message.usage || message.cost) {
        const mapped = mapOmpUsageToTokens(message.usage, message.cost);
        const t = mapped.tokens;
        if (t.input > 0 || t.output > 0 || t.cache.read > 0 || t.cache.write > 0) tokens = t;
      }
    }
  }

  return {
    header,
    title: title ?? header?.title,
    firstUserPrompt,
    leafId,
    lastModel,
    usage: { ...(tokens ? { tokens } : {}), cost },
    entries,
    activeBranch,
  };
}

const FULL_BUDGET_BYTES = 96 * 1024 * 1024;

interface Stamp {
  size: number;
  mtimeMs: number;
}

interface Memo {
  stamp: Stamp;
  summary: Promise<TranscriptSummary | null>;
}

interface Full {
  stamp: Stamp;
  bytes: number;
  transcript: Promise<Transcript | null>;
}

const summaries = new Map<string, Memo>();
/** Insertion order is recency order (a hit re-inserts). */
const fulls = new Map<string, Full>();
let fullBytes = 0;

function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function summaryOf(transcript: Transcript): TranscriptSummary {
  const { entries: _entries, activeBranch: _activeBranch, ...summary } = transcript;
  return summary;
}

function dropFull(path: string): void {
  const hit = fulls.get(path);
  if (!hit) return;
  fulls.delete(path);
  fullBytes -= hit.bytes;
}

async function stampOf(path: string): Promise<Stamp | null> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    summaries.delete(path);
    dropFull(path);
    return null;
  }
}

async function parseFile(path: string): Promise<Transcript | null> {
  try {
    return parseTranscript(await Bun.file(path).text());
  } catch {
    return null;
  }
}

/** Full parse of `path`; null when unreadable. Concurrent first reads share one parse. */
export async function readTranscript(path: string): Promise<Transcript | null> {
  const stamp = await stampOf(path);
  if (!stamp) return null;
  const hit = fulls.get(path);
  if (hit && sameStamp(hit.stamp, stamp)) {
    fulls.delete(path);
    fulls.set(path, hit);
    return hit.transcript;
  }
  dropFull(path);
  const transcript = parseFile(path);
  const entry: Full = { stamp, bytes: stamp.size, transcript };
  fulls.set(path, entry);
  fullBytes += entry.bytes;
  summaries.set(path, {
    stamp,
    summary: transcript.then((parsed) => (parsed ? summaryOf(parsed) : null)),
  });
  while (fullBytes > FULL_BUDGET_BYTES && fulls.size > 1) {
    const oldest = fulls.keys().next().value as string;
    if (oldest === path) break;
    dropFull(oldest);
  }
  return transcript;
}

/** Header, title, leaf, model and usage of `path` without retaining its entries; null when unreadable. */
export async function readTranscriptSummary(path: string): Promise<TranscriptSummary | null> {
  const stamp = await stampOf(path);
  if (!stamp) return null;
  const hit = summaries.get(path);
  if (hit && sameStamp(hit.stamp, stamp)) return hit.summary;
  const summary = parseFile(path).then((parsed) => (parsed ? summaryOf(parsed) : null));
  summaries.set(path, { stamp, summary });
  return summary;
}
