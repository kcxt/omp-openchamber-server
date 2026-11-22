// The importer rewrites real user transcripts on first start, so it is tested against throwaway
// directories only: PI_CODING_AGENT_DIR and OPENCHAMBER_DATA_DIR point under /hdd/brute/tmp.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTranscript } from "../src/omp/transcript-reader";
import { runImporter } from "../src/store/importer";
import { SessionDocs } from "../src/store/session-docs";

const TMP_ROOT = "/hdd/brute/tmp";
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_ORPHAN = "33333333-3333-4333-8333-333333333333";

const line = (value: unknown): string => JSON.stringify(value);
const header = (id: string) => line({ type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/proj", version: 3 });
const msg = (id: string, parentId: string | null, role: string, text: string) =>
  line({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message: { role, content: [{ type: "text", text }] } });

// omp's own lines for (a), in order; the legacy sidecar lines are interleaved between them.
const OMP_A = [header(UUID_A), msg("e1", null, "user", "hello"), msg("e2", "e1", "assistant", "hi"), msg("e3", "e2", "user", "again")];
const LEGACY_A = [
  line({ type: "metadata", metadata: { b: 2 }, timestamp: 200 }),
  line({ type: "viewed", viewed: 7000, timestamp: 250 }),
  line({ type: "model_change", model: "x/y", timestamp: 260 }),
  line({ type: "oc_alias", openCodeId: "ses_old", timestamp: 270 }),
  line({ type: "oc_notice", text: "notice", level: "info", timestamp: 400 }),
  line({ type: "metadata", metadata: { a: 3 }, timestamp: 300 }),
];
const TRANSCRIPT_A = `${[OMP_A[0], LEGACY_A[0], OMP_A[1], LEGACY_A[1], LEGACY_A[2], OMP_A[2], LEGACY_A[3], LEGACY_A[4], OMP_A[3], LEGACY_A[5]].join("\n")}\n`;
const OC_A = `${[
  line({ type: "metadata", metadata: { a: 1 }, timestamp: 100 }),
  line({ type: "archive", archived: 5000, timestamp: 150 }),
  line({ type: "viewed", viewed: 100, timestamp: 120 }),
  line({ type: "revert_change", revert: { messageID: "e1" }, timestamp: 160 }),
].join("\n")}\n`;
const TRANSCRIPT_B = `${[header(UUID_B), msg("b1", null, "user", "plain"), msg("b2", "b1", "assistant", "ok")].join("\n")}\n`;
const OC_ORPHAN = `${line({ type: "metadata", metadata: { orphan: true }, timestamp: 1 })}\n`;

let root: string;
let agentDir: string;
let dataDir: string;
let pathA: string;
let pathB: string;
let pathOrphan: string;
const saved: Record<string, string | undefined> = {};

/** path → bytes of every file under `dir`. */
function snapshot(dir: string, out = new Map<string, string>()): Map<string, string> {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) snapshot(path, out);
    else out.set(path, readFileSync(path, "utf8"));
  }
  return out;
}

const both = () => new Map([...snapshot(agentDir), ...snapshot(dataDir)]);

beforeAll(() => {
  for (const key of ["PI_CODING_AGENT_DIR", "OPENCHAMBER_DATA_DIR"]) saved[key] = process.env[key];
  mkdirSync(TMP_ROOT, { recursive: true });
  root = mkdtempSync(join(TMP_ROOT, "importer-"));
  agentDir = join(root, "agent");
  dataDir = join(root, "data");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
  Bun.env.PI_CODING_AGENT_DIR = agentDir;
  Bun.env.OPENCHAMBER_DATA_DIR = dataDir;

  const bucket = join(agentDir, "sessions", "--tmp-proj--");
  mkdirSync(bucket, { recursive: true });
  pathA = join(bucket, `2026-01-01T00-00-00-000Z_${UUID_A}.jsonl`);
  pathB = join(bucket, `2026-01-01T00-00-00-000Z_${UUID_B}.jsonl`);
  pathOrphan = join(bucket, `2026-01-01T00-00-00-000Z_${UUID_ORPHAN}.jsonl`);
  writeFileSync(pathA, TRANSCRIPT_A);
  writeFileSync(`${pathA}.oc`, OC_A);
  writeFileSync(pathB, TRANSCRIPT_B);
  writeFileSync(`${pathOrphan}.oc`, OC_ORPHAN);
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key];
      delete Bun.env[key];
    } else {
      process.env[key] = value;
      Bun.env[key] = value;
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe("importer", () => {
  test("dry run writes nothing", async () => {
    const before = both();
    const report = await runImporter({ dryRun: true });
    expect(report.errors).toEqual([]);
    expect(report.dryRun).toBe(true);
    // It still reports what it would do.
    const a = report.sessions.find((s) => s.uuid === UUID_A)!;
    expect(a.transcriptRecords).toBe(LEGACY_A.length);
    expect(a.ocRecords).toBe(4);
    expect(a.doc.metadata).toEqual({ a: 3, b: 2 });
    const after = both();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, text] of before) expect(after.get(path)).toBe(text);
    expect(existsSync(join(dataDir, "omp-sessions"))).toBe(false);
  });

  test("a real run folds legacy records into the doc and leaves only omp's lines in the transcript", async () => {
    const leafBefore = parseTranscript(`${OMP_A.join("\n")}\n`).leafId;
    expect(leafBefore).toBe("e3");

    const report = await runImporter();
    expect(report.errors).toEqual([]);
    expect(report.fullPass).toBe(true);
    expect(report.orphanOcFiles).toEqual([`${pathOrphan}.oc`]);
    expect(report.sessions.some((s) => s.uuid === UUID_A && !s.transcriptDeferred)).toBe(true);

    // (a) exactly the original omp entries, byte-identical, in order.
    const rewritten = readFileSync(pathA, "utf8");
    expect(rewritten).toBe(`${OMP_A.join("\n")}\n`);
    expect(parseTranscript(rewritten).leafId).toBe(leafBefore);
    expect(parseTranscript(rewritten).entries.map((e) => e.id).filter(Boolean)).toEqual(["e1", "e2", "e3"]);

    const doc = await SessionDocs.get(UUID_A);
    expect(doc.metadata).toEqual({ a: 3, b: 2 });
    expect(doc.archivedAt).toBe(5000);
    expect(doc.viewedAt).toBe(7000);
    expect(doc.revert).toEqual({ messageID: "e1" });
    expect(doc.legacyNotices).toEqual([{ text: "notice", level: "info", timestamp: 400 }]);

    expect(existsSync(`${pathA}.oc`)).toBe(false);
    expect(readFileSync(`${pathA}.oc.migrated`, "utf8")).toBe(OC_A);

    // (b) a transcript with no legacy data is untouched byte for byte, and gets no doc.
    expect(readFileSync(pathB, "utf8")).toBe(TRANSCRIPT_B);
    expect(existsSync(join(dataDir, "omp-sessions", `${UUID_B}.json`))).toBe(false);

    // (c) an orphan .jsonl.oc has no transcript to import into: left alone.
    expect(readFileSync(`${pathOrphan}.oc`, "utf8")).toBe(OC_ORPHAN);
    expect(existsSync(`${pathOrphan}.oc.migrated`)).toBe(false);
  });

  test("a second run is a no-op", async () => {
    const before = both();
    const mtimes = new Map([...before.keys()].map((path) => [path, statSync(path).mtimeMs]));
    const report = await runImporter();
    expect(report.errors).toEqual([]);
    expect(report.fullPass).toBe(false);
    expect(report.sessions).toEqual([]);
    const after = both();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, text] of before) {
      expect(after.get(path)).toBe(text);
      expect(statSync(path).mtimeMs).toBe(mtimes.get(path)!);
    }
  });
});
