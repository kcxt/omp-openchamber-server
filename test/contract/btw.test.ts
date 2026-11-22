// `/btw` side questions over RPC (modes/rpc/rpc-btw.ts, session/btw-history.ts): an ephemeral turn that streams
// `btw_delta` frames, reports `btw_record` snapshots, opens no agent run, leaves the transcript alone and checkpoints
// every turn into `<session file without .jsonl>/btw-history/entry-<id>.json`. Runs against the stub and the real omp.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { must, Rig, sleep, type Frame, type OmpChild } from "./harness";

setDefaultTimeout(90_000);

const rig = new Rig();
let c: OmpChild;
beforeAll(async () => { c = await rig.spawn(); });
afterAll(() => rig.close());

const entries = async () => (await c.ok<{ entries: Frame[]; leafId?: string }>({ type: "get_entries" }));
const sessionFile = async () => (await c.ok({ type: "get_state" })).sessionFile as string;
const historyDir = async () => join((await sessionFile()).replace(/\.jsonl$/, ""), "btw-history");
const stored = async (id: string): Promise<Frame | undefined> => {
  const file = join(await historyDir(), `entry-${id}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
};
async function until(what: string, probe: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

describe(`/btw side questions (${rig.kind})`, () => {
  test("streams the answer, opens no run, journals nothing and checkpoints the topic", async () => {
    rig.setScript({ turns: [{ when: "BTW-ONE", steps: [{ text: "the side answer" }] }] });
    const first = c.mark();
    await c.send({ type: "prompt", message: "main conversation" });
    await c.settled(first);
    const before = await entries();

    const m = c.mark();
    const response = await c.send({ type: "btw", question: "BTW-ONE what is this?" });
    expect(response.success).toBe(true);
    const record = response.data.record as Frame;
    expect(record).toMatchObject({ question: "BTW-ONE what is this?", answer: "", status: "running", leafId: before.leafId });
    expect(typeof record.id).toBe("string");

    const done = await c.waitFor((f) => f.type === "btw_record" && f.record?.status !== "running", { from: m, label: "terminal btw_record" });
    expect(done.record).toMatchObject({ id: record.id, status: "complete", answer: "the side answer", leafId: before.leafId });

    // Frame order: the running record first, then the response, the deltas, the terminal record.
    const since = c.frames.slice(m).filter((f) => ["btw_record", "btw_delta"].includes(f.type) || (f.type === "response" && f.command === "btw"));
    expect(since[0]).toMatchObject({ type: "btw_record", record: { status: "running" } });
    expect(since.findIndex((f) => f.type === "response")).toBeLessThan(since.findIndex((f) => f.type === "btw_delta"));
    expect(since.at(-1)).toMatchObject({ type: "btw_record", record: { status: "complete" } });
    const deltas = since.filter((f) => f.type === "btw_delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((f) => f.recordId === record.id)).toBe(true);
    expect(deltas.map((f) => f.delta).join("")).toBe("the side answer");

    // An ephemeral turn: no agent run, no transcript entry, the main context is untouched.
    const frameTypes = new Set(c.frames.slice(m).map((f) => f.type));
    for (const type of ["agent_start", "turn_start", "message_start", "agent_end", "session_settled"]) expect(frameTypes.has(type)).toBe(false);
    const after = await entries();
    expect(after.entries.length).toBe(before.entries.length);
    expect(after.leafId).toBe(before.leafId);

    // The checkpoint file.
    await until("the topic checkpoint", async () => (await stored(record.id))?.status === "complete");
    expect(await stored(record.id)).toMatchObject({ id: record.id, question: "BTW-ONE what is this?", answer: "the side answer", status: "complete", leafId: before.leafId });
    expect(readdirSync(await historyDir()).filter((name) => name.endsWith(".json"))).toContain(`entry-${record.id}.json`);

    const history = await c.ok<{ records: Frame[] }>({ type: "get_btw_history" });
    expect(history.records.find((r) => r.id === record.id)).toMatchObject({ status: "complete", answer: "the side answer" });
  });

  test("works while the main run is streaming, which keeps running", async () => {
    rig.setScript({ turns: [
      { when: "BTW-MAIN", steps: [{ text: "main working " }, { sleep: 1_500 }, { text: "main done" }] },
      { when: "BTW-TWO", steps: [{ text: "answered meanwhile" }] },
    ] });
    const m = c.mark();
    await c.send({ type: "prompt", message: "BTW-MAIN go" });
    await c.waitType("agent_start", { from: m });
    const asked = c.mark();
    const response = await c.send({ type: "btw", question: "BTW-TWO now?" });
    expect(response.success).toBe(true);
    const id = response.data.record.id as string;
    const done = await c.waitFor((f) => f.type === "btw_record" && f.record?.id === id && f.record?.status === "complete", { from: asked, label: "btw complete" });
    expect(done.record.answer).toBe("answered meanwhile");
    // The main run was not touched by the side turn: it is still the one run, and ends on its own.
    expect(c.frames.slice(asked).filter((f) => f.type === "agent_start").length).toBe(0);
    expect(c.frames.slice(m).some((f) => f.type === "agent_end")).toBe(false);
    await c.settled(m);
    expect(c.frames.slice(m).filter((f) => f.type === "agent_start").length).toBe(1);
  });

  test("a second question while one runs is refused, and cancel ends the running one", async () => {
    rig.setScript({ turns: [{ when: "BTW-SLOW", steps: [{ text: "slow " }, { sleep: 3_000 }, { text: "never" }] }] });
    const m = c.mark();
    const response = await c.send({ type: "btw", question: "BTW-SLOW question" });
    const id = response.data.record.id as string;
    const refused = await c.send({ type: "btw", question: "another" });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("still running");

    expect((await c.ok<{ cancelled: boolean }>({ type: "btw_cancel", recordId: id })).cancelled).toBe(true);
    const done = await c.waitFor((f) => f.type === "btw_record" && f.record?.id === id && f.record?.status === "cancelled", { from: m, label: "btw cancelled" });
    expect(done.record.status).toBe("cancelled");
    await until("the cancelled checkpoint", async () => (await stored(id))?.status === "cancelled");
    expect((await c.ok<{ cancelled: boolean }>({ type: "btw_cancel" })).cancelled).toBe(false);
    expect(must(await stored(id), "stored record").question).toBe("BTW-SLOW question");
  });

  test("an empty question is refused", async () => {
    const r = await c.send({ type: "btw", question: "   " });
    expect(r.success).toBe(false);
    expect(r.error).toContain("non-empty question");
  });
});
