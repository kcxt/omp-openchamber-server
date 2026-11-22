import { readFileSync } from "node:fs";
import { readdir, stat, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { serializeTitleSlot } from "./title";
import { emitOpenCodeV2Event, emitSessionUpdated } from "../../shared/sse";
import { readTranscriptSummary } from "../../omp/transcript-reader";
import { SessionDocs, type SessionDoc, type SessionDocRevert } from "../../store/session-docs";
import type { OpenCodeSession, TokenBreakdown } from "../types";

import {
  encodeCwd,
  isSessionBucketOf,
  ompSessionsRoot,
  sameDirectory,
  sessionBucketNames,
} from "./paths";

export { encodeCwd };

interface SessionHeader {
  id: string;
  cwd: string;
  title?: string;
  timestamp: string;
  version?: string;
  firstUserPrompt?: string;
  metadata?: Record<string, unknown>;
  archived?: number;
  viewed?: number;
  parentSession?: string;
  model?: { providerID: string; modelID: string; variant?: string };
  tokens?: TokenBreakdown;
  cost?: number;
  revert?: SessionDocRevert;
  /** Client-minted OpenCode id (nanoid form) this omp session answers to. */
  openCodeId?: string;
  /** OpenCode parent (a child session created through the API); `parentSession` alone is only omp lineage. */
  childOf?: string;
}

/** Convert an internal omp UUID into the external OpenCode session id. */
export function toOpenCodeSessionId(ompId: string): string {
  if (ompId.startsWith("ses_")) return ompId;
  const compact = ompId.replace(/-/g, "").toLowerCase();
  return `ses_${compact}`;
}

/** Convert an external OpenCode session id back into the internal omp UUID. */
export function fromOpenCodeSessionId(openCodeId: string): string {
  if (!openCodeId.startsWith("ses_")) return openCodeId;
  const raw = openCodeId.slice(4).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(raw)) return openCodeId;
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20, 32),
  ].join("-");
}

function normalizeSessionAlias(value: string): string {
  return value
    .replace(/\.jsonl$/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function isCanonicalOpenCodeSessionId(openCodeId: string): boolean {
  return /^ses_[0-9a-f]{32}$/i.test(openCodeId);
}

/**
 * OpenChamber mints session ids client-side (`ses_` + nanoid) and requires the
 * server to echo the exact value, so non-UUID ids are carried verbatim in the
 * omp header's `openCodeId` alongside the omp UUID used for file naming.
 */
function isExternalOpenCodeSessionId(openCodeId: string): boolean {
  return /^ses_[A-Za-z0-9_-]{6,}$/.test(openCodeId);
}

const OMP_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}";
const OMP_UUID_ONLY = new RegExp(`^(${OMP_UUID_PATTERN})$`, "i");
const OMP_UUID_AT_END = new RegExp(`(${OMP_UUID_PATTERN})(?:\\.jsonl)?$`, "i");

function extractOmpUuid(value: string): string | undefined {
  return value.match(OMP_UUID_AT_END)?.[1];
}

/**
 * Normalize a parent reference without treating an arbitrary transcript path
 * as an OMP session id. OMP headers may store either an OpenCode id, a UUID,
 * or the absolute path to the parent transcript.
 */
function normalizeSessionReference(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (isCanonicalOpenCodeSessionId(trimmed)) {
    return `ses_${trimmed.slice(4).toLowerCase()}`;
  }

  const directUuid = trimmed.match(OMP_UUID_ONLY)?.[1];
  if (directUuid) return toOpenCodeSessionId(directUuid);

  const pathUuid = extractOmpUuid(trimmed);
  if (pathUuid) return toOpenCodeSessionId(pathUuid);

  // Preserve the existing fallback for non-path OMP aliases, but never turn a
  // malformed absolute transcript path into `ses_/some/path`.
  if (trimmed.includes("/") || trimmed.includes("\\") || /\.jsonl$/i.test(trimmed)) {
    return undefined;
  }
  return toOpenCodeSessionId(trimmed);
}

/**
 * Resolve the parent id exposed by the OpenCode session contract. A child
 * artifact directory is authoritative because OMP can write a transcript-path
 * parentSession header that otherwise loses the parent's UUID.
 */
export function normalizeParentSessionId(
  parentSession: string | undefined,
  artifactParentReference?: string,
): string | undefined {
  return normalizeSessionReference(artifactParentReference) ?? normalizeSessionReference(parentSession);
}

/**
 * Read only the persisted session UUID from the header without waiting on the
 * async store scanner. Subagent lifecycle frames can arrive synchronously
 * with the file creation, so the event bridge needs a small synchronous fast
 * path to publish the canonical id before the UI fetches the child transcript.
 */
export function readSessionIdSync(filePath: string): string | undefined {
  try {
    const text = readFileSync(filePath, "utf8");
    for (const line of text.split("\n").slice(0, 200)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "session" && typeof entry.id === "string" && entry.id.length > 0) {
          return entry.id;
        }
      } catch {
        // Skip title slots and malformed preamble lines.
      }
    }
  } catch {
    // The file may not have been flushed yet; callers retain their fallback id.
  }
  return undefined;
}

/**
 * A session's list-facing header: the memoised TranscriptReader summary of the
 * transcript (omp's own records) overlaid with the session's SessionDoc
 * (OpenChamber-owned data). The reader memoises on the file's size and mtime, so
 * a listing of hundreds of sessions re-parses only files omp touched.
 */
export async function readSessionHeader(filePath: string): Promise<SessionHeader | null> {
  const summary = await readTranscriptSummary(filePath);
  const raw = summary?.header;
  if (!summary || !raw) return null;
  const doc = await SessionDocs.get(raw.id);

  const providerID = summary.lastModel.providerID ?? raw.model?.providerID;
  const modelID = summary.lastModel.modelID ?? raw.model?.modelID;
  const model = providerID && modelID
    ? { providerID, modelID, variant: summary.lastModel.thinking ?? raw.model?.variant ?? "default" }
    : undefined;
  const metadata = { ...raw.metadata, ...doc.metadata };

  const header: SessionHeader = {
    id: raw.id,
    cwd: raw.cwd,
    timestamp: raw.timestamp,
    version: raw.version,
    parentSession: raw.parentSession,
    title: summary.title,
    firstUserPrompt: summary.firstUserPrompt,
    model,
    openCodeId: raw.openCodeId,
    childOf: raw.openCodeParent,
    tokens: summary.usage.tokens,
    cost: summary.usage.cost,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    archived: doc.archivedAt,
    viewed: doc.viewedAt,
    revert: doc.revert,
  };
  return header;
}

/** The OpenCode shape of a staged revert: the redo leaf is the sidecar's own. */
function publicRevert(revert: SessionDocRevert): NonNullable<OpenCodeSession["revert"]> {
  const { redoLeafId: _redoLeafId, ...visible } = revert;
  return visible;
}

async function buildOpenCodeSession(
  header: SessionHeader,
  filePath: string,
  artifactParentReference?: string,
): Promise<OpenCodeSession> {
  const openCodeId = header.openCodeId ?? toOpenCodeSessionId(header.id);
  // `parentSession` is omp lineage (a /fork): such a session is an ordinary
  // top-level one. Only an artifact sub-session (a subagent) or one created
  // through the API as a child has a parent.
  const parentID = normalizeParentSessionId(header.childOf, artifactParentReference);
  const compactId = header.id.replace(/-/g, "");
  const first8 = compactId.slice(0, 8);
  const created = Date.parse(header.timestamp) || Date.now();
  let updated = created;

  try {
    const s = await stat(filePath);
    if (s.mtimeMs) updated = Math.floor(s.mtimeMs);
  } catch { /* keep created as fallback */ }

  let title = header.title;
  if (!title && header.firstUserPrompt) {
    const clean = header.firstUserPrompt.replace(/\s+/g, " ").trim();
    title = clean.length > 50 ? `${clean.slice(0, 47)}...` : clean;
  }
  if (!title) {
    title = `Session ${first8}`;
  }

  const session: OpenCodeSession = {
    id: openCodeId,
    slug: openCodeId,
    projectID: "global",
    directory: header.cwd,
    path: filePath,
    title,
    ...(parentID ? { parentID } : {}),
    agent: "omp",
    model: header.model
      ? {
          id: header.model.modelID,
          providerID: header.model.providerID,
          modelID: header.model.modelID,
          variant: header.model.variant || "default",
        }
      : { id: "omp", providerID: "omp", modelID: "omp", variant: "default" },
    version: header.version || "0.0.0",
    time: {
      created,
      updated,
      ...(header.archived !== undefined ? { archived: header.archived } : {}),
      ...(header.viewed !== undefined ? { viewed: header.viewed } : {}),
    },
    cost: header.cost ?? 0,
    tokens: header.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    metadata: header.metadata,
    revert: header.revert ? publicRevert(header.revert) : undefined,
  };
  return session;
}

/**
 * Resolve a parent reference to the omp UUID stored in the transcript header.
 * Client-minted OpenCode ids are not UUIDs, so a fork/continuation of one has
 * to be looked up rather than decoded.
 */
async function resolveOmpParentId(parentID?: string): Promise<string | undefined> {
  if (!parentID) return undefined;
  if (isCanonicalOpenCodeSessionId(parentID)) return fromOpenCodeSessionId(parentID);
  const parent = await getOmpSessionByOpenCodeId(parentID);
  return parent ? fromOpenCodeSessionId(parent.id) : fromOpenCodeSessionId(parentID);
}

export async function createOmpSession(
  directory?: string | null,
  options?: { id?: string; title?: string; parentID?: string; model?: { providerID: string; modelID: string; variant: string }; metadata?: Record<string, unknown> },
): Promise<OpenCodeSession> {
  const cwd = directory || process.cwd();
  const canonicalID = options?.id && isCanonicalOpenCodeSessionId(options.id)
    ? fromOpenCodeSessionId(options.id)
    : undefined;
  const externalID = canonicalID === undefined && options?.id && isExternalOpenCodeSessionId(options.id)
    ? options.id
    : undefined;
  const uuid = canonicalID ?? randomUUID();
  const parentOmpID = await resolveOmpParentId(options?.parentID);
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const fileName = `${fileTimestamp}_${uuid}.jsonl`;

  const encoded = encodeCwd(cwd);
  const dirPath = join(ompSessionsRoot(), encoded);
  await mkdir(dirPath, { recursive: true });

  const filePath = join(dirPath, fileName);
  // The one write the sidecar makes to a transcript: the new file's slot and header, before any omp has it open.
  const titleSlot = serializeTitleSlot({
    title: options?.title ?? "",
    source: options?.title ? "user" : undefined,
    updatedAt: timestamp,
  });
  const headerRecord = {
    type: "session",
    id: uuid,
    timestamp,
    cwd,
    title: options?.title,
    provider: options?.model?.providerID ?? "omp",
    providerID: options?.model?.providerID ?? "omp",
    modelId: options?.model?.modelID ?? "omp",
    variant: options?.model?.variant ?? "default",
    thinkingLevel: "off",
    version: 3,
    openCodeId: externalID,
    parentSession: parentOmpID,
    ...(parentOmpID ? { openCodeParent: parentOmpID } : {}),
  };

  await Bun.write(filePath, titleSlot + JSON.stringify(headerRecord) + "\n");
  // OpenChamber's blob lives in the session doc, not in omp's header.
  if (options?.metadata) await SessionDocs.update(uuid, (doc) => { doc.metadata = { ...options.metadata }; });
  return buildOpenCodeSession(
    {
      id: uuid,
      cwd,
      title: options?.title,
      timestamp,
      version: "3",
      model: options?.model ?? { providerID: "omp", modelID: "omp", variant: "default" },
      metadata: options?.metadata,
      openCodeId: externalID,
      parentSession: parentOmpID,
      childOf: parentOmpID,
    },
    filePath,
  );
}

export async function deleteOmpSession(
  openCodeId: string,
  directory?: string | null,
): Promise<boolean> {
  const session = (await getOmpSessionByOpenCodeId(openCodeId, directory)) || (await getOmpSessionByOpenCodeId(openCodeId));
  if (!session) return false;
  try {
    const docKey = (await readSessionHeader(session.path))?.id;
    await unlink(session.path);
    if (docKey) await SessionDocs.remove(docKey);
    return true;
  } catch {
    return false;
  }
}

export async function updateOmpSession(
  openCodeId: string,
  updates: {
    metadata?: Record<string, unknown>;
    revert?: SessionDocRevert | null;
    time?: { archived?: number | null; viewed?: number };
  },
  directory?: string | null,
): Promise<OpenCodeSession | null> {
  const session = (await getOmpSessionByOpenCodeId(openCodeId, directory)) || (await getOmpSessionByOpenCodeId(openCodeId));
  if (!session) return null;

  const docKey = (await readSessionHeader(session.path))?.id;
  /** Persists into the session's doc; a doc that cannot be written keeps the existing value. */
  const persist = async (change: (doc: SessionDoc) => void): Promise<boolean> => {
    if (!docKey) return false;
    try {
      await SessionDocs.update(docKey, change);
      return true;
    } catch {
      return false;
    }
  };

  if (updates.revert !== undefined) {
    const revert = updates.revert;
    if (await persist((doc) => {
      if (revert) doc.revert = revert;
      else delete doc.revert;
    })) {
      session.revert = revert ? publicRevert(revert) : undefined;
      session.time.updated = Date.now();
    }
  }

  if (updates.metadata !== undefined && typeof updates.metadata === "object") {
    const metadata = updates.metadata;
    if (await persist((doc) => { doc.metadata = { ...doc.metadata, ...metadata }; })) {
      session.metadata = { ...(session.metadata || {}), ...metadata };
      session.time.updated = Date.now();
      emitSessionUpdated(session as unknown as Record<string, unknown>, session.directory);
    }
  }

  if (updates.time?.archived !== undefined) {
    const archived = updates.time.archived ?? 0;
    if (await persist((doc) => {
      if (archived) doc.archivedAt = archived;
      else delete doc.archivedAt;
    })) {
      const { archived: _previous, ...time } = session.time;
      session.time = archived ? { ...time, archived } : time;
      session.time.updated = Date.now();
      emitSessionUpdated(session as unknown as Record<string, unknown>, session.directory);
    }
  }

  // Viewing is a read marker, not a change: it deliberately leaves
  // time.updated alone so the session list keeps its order.
  if (updates.time?.viewed !== undefined) {
    const viewed = updates.time.viewed;
    if (await persist((doc) => { doc.viewedAt = viewed; })) {
      session.time = { ...session.time, viewed };
      emitOpenCodeV2Event("session.viewed", { sessionID: openCodeId, idle: viewed }, session.directory);
    }
  }

  return session;
}

export async function listOmpSessions(
  directory?: string | null,
  options?: { all?: boolean; limit?: number; archived?: boolean; search?: string },
): Promise<OpenCodeSession[]> {
  const all = options?.all ?? false;
  const limit = options?.limit;
  const archived = options?.archived;
  const search = options?.search?.trim();
  const searchLower = search ? search.toLowerCase() : undefined;
  const sessions: OpenCodeSession[] = [];

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = (await readdir(ompSessionsRoot(), { withFileTypes: true })) as unknown as {
      name: string;
      isDirectory(): boolean;
    }[];
  } catch { return sessions; }

  let dirs = entries.filter((e) => e.isDirectory());
  if (!all && directory) {
    const buckets = sessionBucketNames(directory);
    dirs = dirs.filter((e) => isSessionBucketOf(e.name, buckets));
  } else if (!all) {
    return sessions;
  }

  for (const dir of dirs) {
    const dirPath = join(ompSessionsRoot(), dir.name);
    let dirents: { name: string; isFile(): boolean; isDirectory(): boolean }[];
    try {
      dirents = (await readdir(dirPath, { withFileTypes: true })) as unknown as {
        name: string;
        isFile(): boolean;
        isDirectory(): boolean;
      }[];
    } catch { continue; }

    for (const ent of dirents) {
      if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        const filePath = join(dirPath, ent.name);
        const header = await readSessionHeader(filePath);
        if (!header) continue;
        if (!all && !sameDirectory(header.cwd, directory!)) continue;
        if (archived !== true && !!header.archived) continue;

        if (searchLower) {
          const titleMatch = header.title?.toLowerCase().includes(searchLower);
          const promptMatch = header.firstUserPrompt?.toLowerCase().includes(searchLower);
          const idMatch = header.id.toLowerCase().includes(searchLower);
          const cwdMatch = header.cwd.toLowerCase().includes(searchLower);
          if (!titleMatch && !promptMatch && !idMatch && !cwdMatch) {
            continue;
          }
        }

        sessions.push(await buildOpenCodeSession(header, filePath));
        if (limit !== undefined && sessions.length >= limit) break;
      } else if (ent.isDirectory()) {
        const subDirPath = join(dirPath, ent.name);
        const parentOmpUuid = extractOmpUuid(ent.name);

        let subFiles: string[];
        try {
          subFiles = await readdir(subDirPath);
        } catch {
          continue;
        }

        for (const subFile of subFiles) {
          if (!subFile.endsWith(".jsonl")) continue;
          const subFilePath = join(subDirPath, subFile);
          const subHeader = await readSessionHeader(subFilePath);
          if (!subHeader) continue;
          if (!subHeader.title) {
            subHeader.title = subFile.slice(0, -6);
          }
          if (!all && !sameDirectory(subHeader.cwd, directory!)) continue;
          if (archived !== true && !!subHeader.archived) continue;

          if (searchLower) {
            const titleMatch = subHeader.title?.toLowerCase().includes(searchLower);
            const promptMatch = subHeader.firstUserPrompt?.toLowerCase().includes(searchLower);
            const idMatch = subHeader.id.toLowerCase().includes(searchLower);
            const cwdMatch = subHeader.cwd.toLowerCase().includes(searchLower);
            if (!titleMatch && !promptMatch && !idMatch && !cwdMatch) {
              continue;
            }
          }

          sessions.push(await buildOpenCodeSession(subHeader, subFilePath, parentOmpUuid));
          if (limit !== undefined && sessions.length >= limit) break;
        }
      }
    }
    if (limit !== undefined && sessions.length >= limit) break;
  }

  return sessions;
}

export async function getOmpSessionByOpenCodeId(
  openCodeId: string,
  directory?: string | null,
): Promise<OpenCodeSession | null> {
  const ompId = fromOpenCodeSessionId(openCodeId);
  const requestedAlias = isCanonicalOpenCodeSessionId(openCodeId)
    ? undefined
    : normalizeSessionAlias(openCodeId.replace(/^ses_/i, ""));

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = (await readdir(ompSessionsRoot(), { withFileTypes: true })) as unknown as {
      name: string;
      isDirectory(): boolean;
    }[];
  } catch { return null; }

  let dirs = entries.filter((e) => e.isDirectory());
  if (directory) {
    const buckets = sessionBucketNames(directory);
    dirs = dirs.filter((e) => isSessionBucketOf(e.name, buckets));
  }

  for (const dir of dirs) {
    const dirPath = join(ompSessionsRoot(), dir.name);
    let dirents: { name: string; isFile(): boolean; isDirectory(): boolean }[];
    try {
      dirents = (await readdir(dirPath, { withFileTypes: true })) as unknown as {
        name: string;
        isFile(): boolean;
        isDirectory(): boolean;
      }[];
    } catch { continue; }

    for (const ent of dirents) {
      if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        const filePath = join(dirPath, ent.name);
        const header = await readSessionHeader(filePath);
        if (!header) continue;
        if (
          header.id === ompId ||
          toOpenCodeSessionId(header.id) === openCodeId ||
          (header.openCodeId && header.openCodeId === openCodeId) ||
          (requestedAlias !== undefined && normalizeSessionAlias(header.title ?? "") === requestedAlias)
        ) {
          if (directory && !sameDirectory(header.cwd, directory)) continue;
          return buildOpenCodeSession(header, filePath);
        }
      } else if (ent.isDirectory()) {
        const subDirPath = join(dirPath, ent.name);
        const parentOmpUuid = extractOmpUuid(ent.name);

        let subFiles: string[];
        try {
          subFiles = await readdir(subDirPath);
        } catch {
          continue;
        }

        for (const subFile of subFiles) {
          if (!subFile.endsWith(".jsonl")) continue;
          const subFilePath = join(subDirPath, subFile);
          const subHeader = await readSessionHeader(subFilePath);
          if (!subHeader) continue;
          const childAlias = normalizeSessionAlias(subFile);
          if (
            subHeader.id === ompId ||
            toOpenCodeSessionId(subHeader.id) === openCodeId ||
            (subHeader.openCodeId && subHeader.openCodeId === openCodeId) ||
            (requestedAlias !== undefined && (
              childAlias === requestedAlias ||
              normalizeSessionAlias(subHeader.title ?? "") === requestedAlias
            ))
          ) {
            if (!subHeader.title) {
              subHeader.title = subFile.slice(0, -6);
            }
            if (directory && !sameDirectory(subHeader.cwd, directory)) continue;
            return buildOpenCodeSession(subHeader, subFilePath, parentOmpUuid);
          }
        }
      }
    }
  }

  return null;
}

export async function listOmpChildSessions(
  parentOpenCodeId: string,
  directory?: string | null,
): Promise<OpenCodeSession[]> {
  const allSessions = await listOmpSessions(directory, { all: !directory });
  return allSessions.filter((s) => s.parentID === parentOpenCodeId);
}
