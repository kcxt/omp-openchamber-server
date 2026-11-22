/**
 * Sidecar-owned records about an omp transcript (title/agent/model picks,
 * revert and archive markers, view stamps, alias, command notices).
 *
 * They MUST NOT live in omp's own `<session>.jsonl`. omp replays that file as a
 * tree: the active leaf is the last line's `id`, and every later append parents
 * onto it. A line without an `id` leaves the leaf undefined, so the next load
 * (child respawn, idle release, restart, compaction reload) sees an empty
 * branch and the agent answers as if the session were brand new. They go in a
 * neighbouring `<session>.jsonl.oc` file that omp never reads.
 */
import { randomUUID } from "node:crypto";
import { appendFile, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const OC_RECORD_TYPES: ReadonlySet<string> = new Set([
  "oc_alias",
  "oc_notice",
  "agent_change",
  "model_change",
  "revert_change",
  "metadata",
  "archive",
  "viewed",
]);

export function ocRecordsPath(transcriptPath: string): string {
  return `${transcriptPath}.oc`;
}

export async function appendOcRecord(transcriptPath: string, record: Record<string, unknown>): Promise<void> {
  await appendFile(ocRecordsPath(transcriptPath), JSON.stringify(record) + "\n");
}

/** Raw lines of the sidecar file; empty when there is none. */
export async function readOcRecordLines(transcriptPath: string): Promise<string[]> {
  try {
    return (await readFile(ocRecordsPath(transcriptPath), "utf8")).split("\n");
  } catch {
    return [];
  }
}

/** Transcript + sidecar stat folded into one change stamp. */
export async function ocStamp(transcriptPath: string): Promise<{ mtimeMs: number; size: number } | null> {
  let main;
  try {
    main = await stat(transcriptPath);
  } catch {
    return null;
  }
  const side = await stat(ocRecordsPath(transcriptPath)).catch(() => null);
  return {
    mtimeMs: Math.max(main.mtimeMs, side?.mtimeMs ?? 0),
    size: main.size + (side?.size ?? 0),
  };
}

export async function removeOcRecords(transcriptPath: string): Promise<void> {
  await unlink(ocRecordsPath(transcriptPath)).catch(() => {});
}

function isForeign(line: string): boolean {
  if (!line.trim()) return false;
  try {
    const entry = JSON.parse(line) as Record<string, unknown>;
    return typeof entry.type === "string" && OC_RECORD_TYPES.has(entry.type) && typeof entry.id !== "string";
  } catch {
    return false;
  }
}

/**
 * Moves id-less sidecar records that older versions appended into omp's
 * transcript out into the sidecar file, restoring a valid leaf. Run only while
 * no omp process has the session open (before a child loads it).
 *
 * omp's own `model_change` and `custom` entries carry an `id` and stay.
 */
export async function quarantineLegacyOcRecords(transcriptPath: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(transcriptPath, "utf8");
  } catch {
    return 0;
  }
  const kept: string[] = [];
  const moved: string[] = [];
  for (const line of text.split("\n")) (isForeign(line) ? moved : kept).push(line);
  if (moved.length === 0) return 0;

  // Sidecar first: a crash between the two writes duplicates records, never loses them.
  await appendFile(ocRecordsPath(transcriptPath), moved.join("\n") + "\n");
  const temp = join(dirname(transcriptPath), `.${randomUUID()}.oc.tmp`);
  try {
    await writeFile(temp, kept.join("\n"), "utf8");
    await rename(temp, transcriptPath);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  return moved.length;
}
