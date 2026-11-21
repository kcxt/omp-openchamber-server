/**
 * omp's `edit` tool reports what it changed as `details.diff`: one line per
 * entry, `<sign><line>|<text>` (sign is `+`, `-` or a space), hunks separated by
 * blank lines. Context and removed lines carry the old file's line number, added
 * lines the new one. OpenChamber renders `metadata.diff` / `metadata.files[]`
 * only when it is a unified diff with `@@ -a,b +c,d @@` headers, so convert.
 */

const ENTRY = /^([ +-])\s*(\d+)\|(.*)$/;

interface Entry {
  sign: " " | "+" | "-";
  line: number;
  text: string;
}

/** Hunks of unified-diff body lines for one omp diff; undefined when nothing parses. */
export function ompDiffToUnifiedHunks(diff: string): string | undefined {
  const hunks: Entry[][] = [];
  let current: Entry[] = [];
  for (const raw of diff.split("\n")) {
    const match = ENTRY.exec(raw);
    if (!match) {
      if (current.length > 0) hunks.push(current);
      current = [];
      continue;
    }
    current.push({ sign: match[1] as Entry["sign"], line: Number(match[2]), text: match[3] ?? "" });
  }
  if (current.length > 0) hunks.push(current);

  const out: string[] = [];
  let offset = 0; // new line number minus old line number, from the hunks before this one
  for (const hunk of hunks) {
    const firstOld = hunk.find((entry) => entry.sign !== "+");
    const firstAdd = hunk.find((entry) => entry.sign === "+");
    if (!firstOld && !firstAdd) continue;
    const oldStart = firstOld ? firstOld.line : Math.max(0, firstAdd!.line - offset - 1);
    // A hunk that opens with additions numbers them in the new file already.
    const newStart = hunk[0]!.sign === "+" ? hunk[0]!.line : oldStart + offset;
    let oldCount = 0;
    let newCount = 0;
    for (const entry of hunk) {
      if (entry.sign !== "+") oldCount++;
      if (entry.sign !== "-") newCount++;
    }
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const entry of hunk) out.push(`${entry.sign}${entry.text}`);
    offset += newCount - oldCount;
  }
  return out.length > 0 ? out.join("\n") : undefined;
}

function filePatch(path: string, diff: string, op: unknown): string | undefined {
  const body = ompDiffToUnifiedHunks(diff);
  if (!body) return undefined;
  const from = op === "create" ? "/dev/null" : `a/${path}`;
  const to = op === "delete" ? "/dev/null" : `b/${path}`;
  return `--- ${from}\n+++ ${to}\n${body}`;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * OpenChamber tool-part metadata for an omp `edit` result, from the result's
 * `details` (single file, or `perFileResults` for a batch).
 */
export function editToolMetadata(details: unknown, input?: Record<string, unknown>): Record<string, unknown> | undefined {
  return fromDetails(details) ?? fromReplaceInput(input);
}

const firstString = (source: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) if (typeof source[key] === "string") return source[key] as string;
  return undefined;
};

/**
 * Replace-mode calls (`path` + old/new text) when the result carried no diff
 * (older transcripts, a result still pending). The line numbers are unknown, so
 * the hunk is anchored at line 1.
 */
function fromReplaceInput(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const path = firstString(input, ["path", "filePath", "file_path"]);
  const before = firstString(input, ["old_text", "oldText", "old_string", "oldString"]);
  const after = firstString(input, ["new_text", "newText", "new_string", "newString"]);
  if (!path || before === undefined || after === undefined) return undefined;
  const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  const removed = lines(before);
  const added = lines(after);
  const patch = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
  return { files: [{ file: path, filePath: path, patch }], diff: patch };
}

function fromDetails(details: unknown): Record<string, unknown> | undefined {
  if (!record(details)) return undefined;
  const results: Array<Record<string, unknown>> = Array.isArray(details.perFileResults)
    ? details.perFileResults.filter(record)
    : [details];
  const files: Array<Record<string, unknown>> = [];
  for (const result of results) {
    const path = typeof result.path === "string" ? result.path : undefined;
    const diff = typeof result.diff === "string" ? result.diff : undefined;
    if (!path || !diff) continue;
    const patch = filePatch(path, diff, result.op);
    if (patch) files.push({ file: path, filePath: path, patch });
  }
  if (files.length === 0) return undefined;
  return {
    files,
    ...(files.length === 1 ? { diff: files[0]!.patch } : {}),
    ...(typeof details.firstChangedLine === "number" ? { firstChangedLine: details.firstChangedLine } : {}),
  };
}
