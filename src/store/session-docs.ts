/**
 * SessionDocs: the one durable store the sidecar owns. One JSON document per
 * omp session uuid at `$OPENCHAMBER_DATA_DIR/omp-sessions/<uuid>.json`
 * (default data dir as OpenChamber's: `~/.config/openchamber`).
 *
 * Fields (PLAN.md §3.10): `metadata`, `archivedAt`, `viewedAt`, `revert`,
 * `legacyMessageIds`, `visibleParts`, `legacyNotices`. The last two are what omp
 * cannot hold: the typed text of a prompt whose message to the model carried
 * more (synthetic context), and command replies the old sidecar kept before
 * omp journaled them (P2). `legacyNotices` is written only by the importer.
 *
 * Rules: written only through this module, by temp file + rename, serialised
 * per uuid (read-merge-write through `update`). The process is the only writer,
 * so a loaded doc is kept in memory and never re-read; the session list asks
 * for every session's doc and would otherwise pay a disk read each.
 * No SQLite.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { OpenCodePromptTextPart } from "../shared/types";

export interface SessionDocRevert {
  messageID: string;
  /** Leaf to navigate back to on redo (§3.9). */
  redoLeafId?: string;
  partID?: string;
  snapshot?: string;
  files?: unknown[];
}

/** A command reply the old sidecar kept because omp had no record of it, shown in the transcript at `timestamp`. Read-only. */
export interface SessionDocNotice {
  text: string;
  level: string;
  timestamp: number;
}

export interface SessionDoc {
  /** OpenChamber's blob. */
  metadata: Record<string, unknown>;
  archivedAt?: number;
  viewedAt?: number;
  revert?: SessionDocRevert;
  /** omp entry id → client message id, pre-migration messages only. */
  legacyMessageIds?: Record<string, string>;
  /**
   * Client message id → the text parts the user saw, for prompts whose message
   * to the model held more than that (pending synthetic context). The
   * transcript holds the full message.
   */
  visibleParts?: Record<string, OpenCodePromptTextPart[]>;
  /** Command replies from before omp journaled them (P2). Written by the importer only. */
  legacyNotices?: SessionDocNotice[];
}

export function openChamberDataDir(): string {
  const configured = Bun.env.OPENCHAMBER_DATA_DIR || process.env.OPENCHAMBER_DATA_DIR;
  return configured ? resolve(configured) : join(homedir(), ".config", "openchamber");
}

export function sessionDocPath(uuid: string): string {
  return join(openChamberDataDir(), "omp-sessions", `${uuid}.json`);
}

function validUuid(uuid: string): string {
  // The uuid becomes a file name: refuse anything that could leave the directory.
  if (!/^[A-Za-z0-9_-]+$/.test(uuid)) throw new Error(`invalid session uuid: ${JSON.stringify(uuid)}`);
  return uuid;
}

function normalize(raw: unknown): SessionDoc {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  // Docs the importer wrote before P2/P3 hold `notices`, `alias` and `agent`: the notices stay, read-only.
  const { notices, alias: _alias, agent: _agent, ...rest } = source;
  const doc: SessionDoc = {
    ...(rest as Partial<SessionDoc>),
    metadata: source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
      ? source.metadata as Record<string, unknown>
      : {},
  };
  if (Array.isArray(notices) && doc.legacyNotices === undefined) doc.legacyNotices = notices as SessionDocNotice[];
  return doc;
}

const loaded = new Map<string, SessionDoc>();
const writers = new Map<string, Promise<unknown>>();

async function load(path: string): Promise<SessionDoc> {
  const hit = loaded.get(path);
  if (hit) return hit;
  let doc: SessionDoc;
  try {
    doc = normalize(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // A torn or hand-edited doc must not take the session list down: keep it aside and start empty.
      if (!(error instanceof SyntaxError)) throw error;
      await rename(path, `${path}.corrupt-${Date.now()}`).catch(() => {});
    }
    doc = { metadata: {} };
  }
  // A concurrent load or an update may have landed while the file was being read.
  const current = loaded.get(path);
  if (current) return current;
  loaded.set(path, doc);
  return doc;
}

async function persist(path: string, doc: SessionDoc): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(doc)}\n`, "utf8");
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** Serialises `task` behind earlier work on `key`; a failed task does not block the next. */
function serialised<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (writers.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
  const tail = run.catch(() => {});
  writers.set(key, tail);
  void tail.then(() => {
    if (writers.get(key) === tail) writers.delete(key);
  });
  return run;
}

export const SessionDocs = {
  /** A copy of the doc; an empty one when the session has none. Never writes. */
  async get(uuid: string): Promise<SessionDoc> {
    const path = sessionDocPath(validUuid(uuid));
    // Wait for an in-flight write so a read after an `update` resolves sees it.
    await writers.get(path);
    return structuredClone(await load(path));
  },

  /**
   * Read-merge-write. `fn` receives a draft copy and mutates it (or returns a
   * replacement); the result is persisted, then becomes the visible doc. If the
   * write fails the previous doc stays.
   */
  update(uuid: string, fn: (draft: SessionDoc) => SessionDoc | void): Promise<SessionDoc> {
    const path = sessionDocPath(validUuid(uuid));
    return serialised(path, async () => {
      const draft = structuredClone(await load(path));
      const next = normalize(fn(draft) ?? draft);
      await persist(path, next);
      loaded.set(path, next);
      return structuredClone(next);
    });
  },

  /** Deletes the doc (the session itself was deleted). */
  remove(uuid: string): Promise<void> {
    const path = sessionDocPath(validUuid(uuid));
    return serialised(path, async () => {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      loaded.delete(path);
    });
  },
};
