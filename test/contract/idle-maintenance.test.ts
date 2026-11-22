// P4: `get_state.idleMaintenance {recapDueAt?, compactionDueAt?}` (present only while idle work is owed and scheduled)
// and the `recap` frame {recap, createdAt}. The rig lowers the recap delay (real: `recap.idleSeconds`, stub:
// OMP_STUB_RECAP_MS) so the whole cycle takes seconds. Runs against the stub and the real omp.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Rig, sleep, type Frame, type OmpChild } from "./harness";

setDefaultTimeout(120_000);

const RECAP_SECONDS = 2;
const rig = new Rig({ recapSeconds: RECAP_SECONDS });
afterAll(() => rig.close());

const idleOf = async (c: OmpChild) => (await c.ok<Frame>({ type: "get_state" })).idleMaintenance as { recapDueAt?: number; compactionDueAt?: number } | undefined;
const recaps = (c: OmpChild, from: number) => c.frames.slice(from).filter((f) => f.type === "recap");

async function untilDue(c: OmpChild): Promise<number> {
  for (let i = 0; i < 400; i++) {
    const due = (await idleOf(c))?.recapDueAt;
    if (due !== undefined) return due;
    await sleep(25);
  }
  throw new Error("idleMaintenance.recapDueAt never appeared");
}

describe(`P4 idle maintenance (${rig.kind})`, () => {
  test("nothing is owed before any turn: idleMaintenance is absent", async () => {
    const c = await rig.spawn();
    const state = await c.ok<Frame>({ type: "get_state" });
    expect("idleMaintenance" in state).toBe(false);
    expect(state.isSettled).toBe(true);
  });

  test("an owed recap shows its due time, arrives as a recap frame, and the field clears", async () => {
    const c = await rig.spawn();
    rig.setScript({ turns: [] });
    const m = c.mark();
    const before = Date.now();
    await c.send({ type: "prompt", message: "hello" });
    await c.settled(m);

    // while the recap is owed the child must not be released: isSettled alone does not say so
    const due = await untilDue(c);
    expect(due).toBeGreaterThan(before);
    expect(due).toBeLessThanOrEqual(Date.now() + RECAP_SECONDS * 1000 + 500);
    const owed = (await idleOf(c))!;
    expect(owed.compactionDueAt).toBeUndefined();
    expect((await c.ok<Frame>({ type: "get_state" })).isSettled).toBe(true);
    const entries = (await c.ok<{ entries: Frame[] }>({ type: "get_entries" })).entries.length;

    const frame = await c.waitType("recap", { from: m, timeoutMs: 60_000 });
    expect(typeof frame.recap).toBe("string");
    expect(frame.recap.trim().length).toBeGreaterThan(0);
    expect(typeof frame.createdAt).toBe("number");
    expect(frame.createdAt).toBeGreaterThanOrEqual(due);
    expect(recaps(c, m)).toHaveLength(1);

    await sleep(100);
    expect(await idleOf(c)).toBeUndefined();
    // a recap is not a transcript entry
    expect((await c.ok<{ entries: Frame[] }>({ type: "get_entries" })).entries.length).toBe(entries);
  });

  test("new activity supersedes the owed recap: absent while streaming, one recap for the whole sequence", async () => {
    const c = await rig.spawn();
    rig.setScript({ turns: [{ when: "SLOWRUN", steps: [{ text: "working" }, { sleep: 700 }, { text: " more" }] }] });
    let m = c.mark();
    await c.send({ type: "prompt", message: "hello" });
    await c.settled(m);
    m = c.mark();
    await untilDue(c);
    c.fire({ type: "prompt", message: "SLOWRUN go" });
    await c.waitType("agent_start", { from: m });
    const during = await c.ok<Frame>({ type: "get_state" });
    expect(during.isStreaming).toBe(true);
    expect("idleMaintenance" in during).toBe(false);
    await c.settled(m);
    await untilDue(c); // re-armed by the new stretch
    await c.waitType("recap", { from: m, timeoutMs: 60_000 });
    await sleep(RECAP_SECONDS * 1000 + 1500);
    expect(recaps(c, m)).toHaveLength(1);
  });

  test("a prompt inside the recap's delay supersedes it: the recap that arrives follows the newer stretch's settlement", async () => {
    const c = await rig.spawn();
    rig.setScript({ turns: [] });
    let m = c.mark();
    await c.send({ type: "prompt", message: "first" });
    await c.settled(m);
    await untilDue(c);
    m = c.mark();
    await c.send({ type: "prompt", message: "second" });
    await c.settled(m);
    const frame = await c.waitType("recap", { from: m, timeoutMs: 60_000 });
    // the recap that arrives belongs to the second stretch: it is after that stretch's settlement
    expect(c.frames.indexOf(frame)).toBeGreaterThan(c.frames.findIndex((f, i) => i >= m && f.type === "session_settled"));
  });
});
