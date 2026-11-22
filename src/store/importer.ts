/**
 * One-time, idempotent migration of the sidecar's old per-session state into
 * SessionDocs (PLAN.md §3.10). Run it before any omp child is spawned.
 *
 * For each omp session transcript under the sessions root it
 *   1. folds the records of `<session>.jsonl.oc` (`metadata`, `archive`,
 *      `viewed`, `revert_change`, `agent_change`, `oc_alias`, `oc_notice`) and
 *      any id-less sidecar lines still inside the transcript into the session's doc;
 *   2. moves those lines out of the transcript by atomic rewrite (an id-less line
 *      leaves omp's leaf undefined, so the next load would see an empty branch);
 *   3. copies the title DB's client message ids for the session into
 *      `legacyMessageIds` (omp entry id → client id) and the typed text of
 *      prompts sent with extra context into `visibleParts`, so revert-to and
 *      the visible bubble on messages from before the migration keep working;
 *      `oc_notice` records become the read-only `legacyNotices`; `agent_change`
 *      and `oc_alias` records are consumed and dropped (one agent; P3);
 *   4. renames `.jsonl.oc` to `.jsonl.oc.migrated`.
 * `model_change` records are dropped: the model comes from omp's own entries.
 *
 * Ordering makes a crash harmless: the doc is written first (re-folding the same
 * records yields the same doc), the transcript second, the rename last.
 * A finished full pass leaves `omp-sessions/.importer-done`; later runs then only
 * visit sessions that still have a `.jsonl.oc` file, so startup does not re-read
 * gigabytes of transcripts. A transcript that changed while it was being read is
 * left alone (its legacy lines are picked up by a later run).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { ompAgentDir, ompSessionsRoot } from "../omp/paths";
import { isSidecarRecord, parseTranscript, SIDECAR_RECORD_TYPES, type TranscriptEntry } from "../omp/transcript-reader";
import { openChamberDataDir, SessionDocs, type SessionDoc } from "./session-docs";

export interface ImportedSession {
  uuid: string;
  transcript: string;
  /** Records read from the `.jsonl.oc` file / found inside the transcript. */
  ocRecords: number;
  transcriptRecords: number;
  /** Transcript rewrite skipped because omp wrote to it meanwhile. */
  transcriptDeferred: boolean;
  legacyMessageIds: number;
  /** The doc as it was (dry run) or is now written. */
  doc: SessionDoc;
}

export interface ImporterReport {
  dryRun: boolean;
  /** False when a previous full pass finished and only `.jsonl.oc` sessions were visited. */
  fullPass: boolean;
  transcripts: number;
  sessions: ImportedSession[];
  orphanOcFiles: string[];
  errors: Array<{ transcript: string; error: string }>;
}

const SIDECAR_LINE_PREFIX = new RegExp(`^\\{"type":"(?:${[...SIDECAR_RECORD_TYPES].join("|")})"`, "m");

function doneMarkerPath(): string {
  return join(openChamberDataDir(), "omp-sessions", ".importer-done");
}

async function listTranscripts(dir: string, out: string[], depth = 0): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.oc"))) out.push(path);
    // Buckets, then a session's artifact directory holding its subagents' transcripts.
    else if (entry.isDirectory() && depth < 3) await listTranscripts(path, out, depth + 1);
  }
}

function timestampOf(record: TranscriptEntry): number {
  const raw = record.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseLines(lines: string[]): TranscriptEntry[] {
  const records: TranscriptEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed as TranscriptEntry);
    } catch {
      // A torn line carries nothing recoverable.
    }
  }
  return records;
}

/** Folds sidecar records, oldest first, into `doc`. Re-applying the same records gives the same doc. */
function applyRecords(doc: SessionDoc, records: TranscriptEntry[]): void {
  const ordered = records
    .filter((record) => typeof record.type === "string" && SIDECAR_RECORD_TYPES.has(record.type))
    .map((record, index) => ({ record, index, at: timestampOf(record) }))
    .sort((a, b) => a.at - b.at || a.index - b.index);
  for (const { record, at } of ordered) {
    switch (record.type) {
      case "metadata":
        if (record.metadata && typeof record.metadata === "object") {
          doc.metadata = { ...doc.metadata, ...(record.metadata as Record<string, unknown>) };
        }
        break;
      case "archive": {
        const archived = typeof record.archived === "number" ? record.archived : record.archived ? at : 0;
        if (archived > 0) doc.archivedAt = archived;
        else delete doc.archivedAt;
        break;
      }
      case "viewed":
        doc.viewedAt = typeof record.viewed === "number" ? record.viewed : at;
        break;
      case "revert_change": {
        const revert = record.revert as Record<string, unknown> | null | undefined;
        if (revert && typeof revert === "object" && typeof revert.messageID === "string") {
          doc.revert = revert as unknown as NonNullable<SessionDoc["revert"]>;
        } else {
          delete doc.revert;
        }
        break;
      }
      // agent_change, oc_alias: omp has one agent and, with P3, never moves a session; dropped.
      case "oc_notice": {
        if (typeof record.text !== "string" || typeof record.timestamp !== "number") break;
        const notices = doc.legacyNotices ?? [];
        // A crash between the two writes of an older quarantine could duplicate a record.
        if (!notices.some((n) => n.timestamp === record.timestamp && n.text === record.text)) {
          notices.push({
            text: record.text,
            level: typeof record.level === "string" ? record.level : "warn",
            timestamp: record.timestamp,
          });
        }
        doc.legacyNotices = notices;
        break;
      }
      // model_change: the model is read from omp's own entries.
    }
  }
}

function firstText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
        return (block as { text: string }).text.trim();
      }
    }
  }
  return "";
}

/** One row of the old title DB's `session_message_ids` table. */
interface PersistedMessageMapping {
  clientMessageId: string;
  promptText: string;
  promptParts?: Array<{ text: string; synthetic?: boolean }>;
  ompMessageId?: string;
}

/** Read-only handle on the old message-id table in omp's `history.db`; undefined when there is none. */
function openLegacyMessageIds(): { list: (sessionId: string) => PersistedMessageMapping[]; close: () => void } | undefined {
  const path = join(ompAgentDir(), "history.db");
  // Opening a missing database would create it: only read one that exists.
  if (!existsSync(path)) return undefined;
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return undefined;
  }
  const list = (sessionId: string): PersistedMessageMapping[] => {
    try {
      const rows = db.query(
        "SELECT client_message_id, prompt_text, prompt_parts_json, omp_message_id FROM session_message_ids WHERE session_id = ? ORDER BY created_at",
      ).all(sessionId) as Array<{ client_message_id: string; prompt_text: string; prompt_parts_json?: string | null; omp_message_id?: string | null }>;
      return rows.map((row) => {
        let promptParts: PersistedMessageMapping["promptParts"];
        try {
          const parsed = row.prompt_parts_json ? JSON.parse(row.prompt_parts_json) as unknown : undefined;
          if (Array.isArray(parsed)) {
            promptParts = parsed.flatMap((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
              ? [{ text: (part as { text: string }).text, ...((part as { synthetic?: unknown }).synthetic === true ? { synthetic: true } : {}) }]
              : []);
          }
        } catch {
          promptParts = undefined;
        }
        return { clientMessageId: row.client_message_id, promptText: row.prompt_text, promptParts, ompMessageId: row.omp_message_id || undefined };
      });
    } catch {
      // No such table: nothing was ever recorded.
      return [];
    }
  };
  return { list, close: () => db.close() };
}

/**
 * omp entry id → client message id from the title DB. A row bound to an omp id
 * maps directly; an unbound row pairs with the first still-unclaimed user
 * message of the active branch carrying the same text.
 */
function legacyIdsFor(rows: PersistedMessageMapping[], userMessages: Array<{ id: string; text: string }>): Record<string, string> {
  const map: Record<string, string> = {};
  const claimed = new Set<string>();
  for (const row of rows) {
    if (row.ompMessageId) {
      map[row.ompMessageId] = row.clientMessageId;
      claimed.add(row.ompMessageId);
    }
  }
  for (const row of rows) {
    if (row.ompMessageId) continue;
    const text = row.promptText.trim();
    if (!text) continue;
    const match = userMessages.find((m) => !claimed.has(m.id) && m.text === text);
    if (!match) continue;
    map[match.id] = row.clientMessageId;
    claimed.add(match.id);
  }
  return map;
}

async function importSession(
  transcript: string,
  report: ImporterReport,
  dryRun: boolean,
  listLegacyIds: ((sessionId: string) => PersistedMessageMapping[]) | undefined,
): Promise<void> {
  const ocPath = `${transcript}.oc`;
  const before = await stat(transcript);
  const text = await readFile(transcript, "utf8");
  const hasLegacyLines = SIDECAR_LINE_PREFIX.test(text);
  const ocText = await readFile(ocPath, "utf8").catch(() => "");

  // The transcript parse yields the header and the user messages; sidecar lines
  // are skipped by the reader, so they are collected from the raw lines.
  const parsed = parseTranscript(text);
  const uuid = parsed.header?.id;
  if (!uuid) return;

  const keptLines: string[] = [];
  const transcriptRecords: TranscriptEntry[] = [];
  if (hasLegacyLines) {
    for (const line of text.split("\n")) {
      let record: TranscriptEntry | undefined;
      if (SIDECAR_LINE_PREFIX.test(line)) {
        try {
          record = JSON.parse(line) as TranscriptEntry;
        } catch {
          record = undefined;
        }
      }
      if (record && isSidecarRecord(record)) transcriptRecords.push(record);
      else keptLines.push(line);
    }
  }
  const ocRecords = parseLines(ocText.split("\n"));

  let legacy: Record<string, string> = {};
  const parts: Record<string, Array<{ text: string; synthetic?: boolean }>> = {};
  if (listLegacyIds) {
    // The title DB keyed messages by OpenCode id: `ses_` + the uuid without dashes (store.ts#toOpenCodeSessionId,
    // not imported here so the importer stays independent of the server module graph), or a client-minted id.
    const keys = new Set<string>([`ses_${uuid.replace(/-/g, "").toLowerCase()}`, uuid]);
    if (parsed.header?.openCodeId) keys.add(parsed.header.openCodeId);
    for (const record of ocRecords) if (record.type === "oc_alias" && typeof record.openCodeId === "string") keys.add(record.openCodeId);
    const rows = [...keys].flatMap((key) => listLegacyIds(key));
    if (rows.length > 0) {
      const userMessages: Array<{ id: string; text: string }> = [];
      for (const entry of parsed.activeBranch) {
        const message = entry.type === "message" ? entry.message as Record<string, unknown> | undefined : undefined;
        if (message?.role === "user" && typeof entry.id === "string") userMessages.push({ id: entry.id, text: firstText(message) });
      }
      legacy = legacyIdsFor(rows, userMessages);
      // The typed text a prompt was sent with, where the model's message held more (synthetic context).
      for (const row of rows) if (row.promptParts && row.promptParts.length > 0) parts[row.clientMessageId] = row.promptParts;
    }
  }

  const records = [...ocRecords, ...transcriptRecords];
  const hasWork = records.length > 0 || Object.keys(legacy).length > 0;
  if (!hasWork && !existsSync(ocPath)) return;

  const fold = (doc: SessionDoc): void => {
    applyRecords(doc, records);
    if (Object.keys(legacy).length > 0) doc.legacyMessageIds = { ...legacy, ...doc.legacyMessageIds };
    if (Object.keys(parts).length > 0) doc.visibleParts = { ...parts, ...doc.visibleParts };
  };
  let doc: SessionDoc;
  if (dryRun) {
    doc = await SessionDocs.get(uuid);
    fold(doc);
  } else {
    doc = await SessionDocs.update(uuid, fold);
  }

  let deferred = false;
  if (transcriptRecords.length > 0 && !dryRun) {
    const after = await stat(transcript);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      deferred = true;
    } else {
      const temp = join(dirname(transcript), `.${randomUUID()}.import.tmp`);
      try {
        await writeFile(temp, keptLines.join("\n"), "utf8");
        await rename(temp, transcript);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }
    }
  }

  if (!dryRun && existsSync(ocPath)) {
    const target = existsSync(`${ocPath}.migrated`) ? `${ocPath}.migrated-${Date.now()}` : `${ocPath}.migrated`;
    await rename(ocPath, target);
  }

  report.sessions.push({
    uuid,
    transcript,
    ocRecords: ocRecords.length,
    transcriptRecords: transcriptRecords.length,
    transcriptDeferred: deferred,
    legacyMessageIds: Object.keys(legacy).length,
    doc,
  });
}

export async function runImporter(options: { dryRun?: boolean } = {}): Promise<ImporterReport> {
  const dryRun = options.dryRun ?? false;
  const done = existsSync(doneMarkerPath());
  const report: ImporterReport = { dryRun, fullPass: !done, transcripts: 0, sessions: [], orphanOcFiles: [], errors: [] };

  const files: string[] = [];
  await listTranscripts(ompSessionsRoot(), files);
  const transcripts = new Set(files.filter((file) => file.endsWith(".jsonl")));
  for (const file of files) {
    if (file.endsWith(".jsonl.oc") && !transcripts.has(file.slice(0, -3))) report.orphanOcFiles.push(file);
  }
  // Only read a history.db that exists: opening one would create it.
  const legacyIds = openLegacyMessageIds();

  const work = done ? [...transcripts].filter((file) => existsSync(`${file}.oc`)) : [...transcripts];
  report.transcripts = work.length;
  for (const transcript of work) {
    try {
      await importSession(transcript, report, dryRun, legacyIds?.list);
    } catch (error) {
      report.errors.push({ transcript, error: error instanceof Error ? error.message : String(error) });
    }
  }
  legacyIds?.close();

  if (!dryRun && !done && report.errors.length === 0) {
    await mkdir(dirname(doneMarkerPath()), { recursive: true });
    await writeFile(doneMarkerPath(), `${JSON.stringify({ at: new Date().toISOString() })}\n`, "utf8");
  }
  return report;
}
