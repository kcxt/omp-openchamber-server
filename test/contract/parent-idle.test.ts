// R10 (PLAN §3.1): what the parent session reports while background work runs and between goal turns, and which
// get_state combination tells "parent idle, background work running" from "goal continuation due".
// Evidence and conclusions: docs/research/R10-parent-idle.md. Runs against the stub and the real omp.
//
//   parent idle, background running : isStreaming=false isSettled=false hasPendingAsyncWork=true  queuedMessageCount=0
//   goal continuation due            : isStreaming=false isSettled=false hasPendingAsyncWork=false queuedMessageCount=0 goal.status=active
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { must, Rig, sleep, type Frame, type OmpChild } from "./harness";

setDefaultTimeout(120_000);

const rig = new Rig();
let c: OmpChild;
beforeAll(async () => {
  c = await rig.spawn();
  await c.send({ type: "set_subagent_subscription", level: "events" });
});
afterAll(() => rig.close());

interface Sample {
  /** agent_start / agent_end frames seen (since the mark) when this get_state was answered. */
  starts: number;
  ends: number;
  streaming: boolean;
  settled: boolean;
  async: boolean;
  queued: number;
  goal: string | null;
  idleMaintenance: boolean;
  /** Running subagents the same instant. */
  subagents: number;
}

/** The distinguishing fields only, so a whole gap can be compared at once. */
const tuple = (s: Sample) => `streaming=${s.streaming} settled=${s.settled} async=${s.async} queued=${s.queued}`;

async function sample(from: number, withSubagents = false): Promise<Sample> {
  const response = await c.send({ type: "get_state" });
  if (!response.success) throw new Error(`get_state failed: ${response.error}`);
  const r = response.data as Frame;
  // frames the child wrote before this answer: the answer is a snapshot taken at that point of the stream
  const before = c.frames.slice(from, c.frames.lastIndexOf(response));
  const count = (t: string) => before.filter((f) => f.type === t).length;
  const subs = withSubagents ? (await c.ok<{ subagents: Frame[] }>({ type: "get_subagents" })).subagents.filter((s) => s.status === "running").length : 0;
  return {
    starts: count("agent_start"), ends: count("agent_end"),
    streaming: r.isStreaming, settled: r.isSettled, async: r.hasPendingAsyncWork, queued: r.queuedMessageCount,
    goal: r.goal ? String(r.goal.goal?.status ?? r.goal.status) : null,
    idleMaintenance: "idleMaintenance" in r, subagents: subs,
  };
}

/** Poll get_state back to back until `stop` holds for the latest sample (or the stretch settles). */
async function sampleUntil(from: number, stop: (s: Sample) => boolean, opts: { pauseMs?: number; subagents?: boolean; limitMs?: number } = {}): Promise<Sample[]> {
  const out: Sample[] = [];
  const deadline = Date.now() + (opts.limitMs ?? 30_000);
  while (Date.now() < deadline) {
    const s = await sample(from, opts.subagents);
    out.push(s);
    if (stop(s)) return out;
    if (opts.pauseMs) await sleep(opts.pauseMs);
  }
  throw new Error(`sampling never reached its stop condition; last: ${JSON.stringify(out.at(-1))}`);
}

/** Frames between two indexes, noise and the test's own get_state/get_subagents polling dropped. */
const quiet = (from: number, to: number) => c.shape(from, to).filter((l) => l !== "response:get_state" && l !== "response:get_subagents");
/** The last frame that is not one of the test's own command responses. */
const lastEvent = (frames: Frame[]) => frames.filter((f) => f.type !== "response").at(-1)!;

describe(`R10 background work while the parent run has ended (${rig.kind})`, () => {
  test("async bash: parent idle, stretch open; get_state during the gap; the wake run; session_settled last", async () => {
    rig.setScript({
      turns: [{ when: "ASYNCBASH", steps: [{ text: "starting" }, { tool: "bash", args: { command: "sleep 2; echo job-done", async: true }, result: "job-done", asyncMs: 1500 }, { text: "job started" }] }],
    });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "ASYNCBASH go" });
    const pr = await c.waitFor((f) => f.type === "prompt_result" && f.id === p1, { from: m, timeoutMs: 60_000 });
    expect(pr.status).toBe("completed");
    expect(pr.sessionSettled).toBe(false); // the parent run is over, the stretch is not

    // the gap: nothing but state polling happens until the job finishes and wakes the parent
    const gapStart = c.frames.length;
    const gap = await sampleUntil(m, (s) => s.starts >= 2, { pauseMs: 100 });
    const inside = gap.filter((s) => s.starts === 1 && s.ends === 1);
    expect(inside.length).toBeGreaterThanOrEqual(3);
    for (const s of inside) {
      expect(tuple(s)).toBe("streaming=false settled=false async=true queued=0");
      expect(s.goal).toBeNull();
      expect(s.idleMaintenance).toBe(false); // omp arms no recap while background work can still wake it
    }
    const firstWake = c.frames.findIndex((f, i) => i >= gapStart && f.type === "agent_start");
    expect(quiet(gapStart, firstWake)).toEqual([]); // no frame at all between prompt_result and the wake run
    expect(c.frames.slice(m).some((f) => f.type === "session_settled")).toBe(false);

    // the wake run: a custom message carries the job result; then the stretch closes
    await c.settled(m, 60_000);
    await sleep(150);
    const frames = c.frames.slice(m);
    const wake = frames.findIndex((f, i) => f.type === "agent_start" && i > frames.findIndex((x) => x.type === "agent_end"));
    expect(wake).toBeGreaterThan(-1);
    expect(frames.slice(wake).some((f) => f.type === "message_start" && f.message?.role === "custom")).toBe(true);
    expect(lastEvent(frames).type).toBe("session_settled");
    expect(frames.filter((f) => f.type === "session_settled")).toHaveLength(1);
    const end = await sample(m);
    expect(tuple(end)).toBe("streaming=false settled=true async=false queued=0");
  });

  test("async subagent: the parent is idle while it runs and get_subagents lists it; completion wakes the parent", async () => {
    const steps = [{ text: "working" }, { sleep: 1500 }, { text: " done" }];
    rig.setScript({
      turns: [
        { when: "SPAWNSLOW", steps: [{ text: "delegating" }, { tool: "task", args: { name: "Slow", task: "SUBSLOW work", solutionSpace: "x" }, subagent: { steps } } as any, { text: "spawned" }] },
        { when: "SUBSLOW", steps },
      ],
    });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "SPAWNSLOW go" });
    await c.waitFor((f) => f.type === "prompt_result" && f.id === p1, { from: m, timeoutMs: 60_000 });
    const gap = await sampleUntil(m, (s) => s.starts >= 2, { pauseMs: 100, subagents: true });
    const inside = gap.filter((s) => s.starts === 1 && s.ends === 1);
    expect(inside.length).toBeGreaterThanOrEqual(3);
    for (const s of inside) expect(tuple(s)).toBe("streaming=false settled=false async=true queued=0");
    // the child is running in the same window: that is where OpenChamber finds the busy child
    expect(inside.some((s) => s.subagents === 1)).toBe(true);
    const life = c.frames.slice(m).filter((f) => f.type === "subagent_lifecycle").map((f) => f.payload.status);
    expect(life[0]).toBe("started");

    await c.settled(m, 60_000);
    await sleep(150);
    const frames = c.frames.slice(m);
    expect(frames.filter((f) => f.type === "subagent_lifecycle").map((f) => f.payload.status)).toEqual(["started", "completed"]);
    expect(frames.filter((f) => f.type === "agent_start")).toHaveLength(2);
    expect(lastEvent(frames).type).toBe("session_settled");
    expect(tuple(await sample(m))).toBe("streaming=false settled=true async=false queued=0");
    expect((await c.ok<{ subagents: Frame[] }>({ type: "get_subagents" })).subagents).toEqual([]);
  });
});

describe(`R10 goal continuation (${rig.kind})`, () => {
  // Turn 1 makes progress (a tool call), turn 2 completes the goal. The two binaries word the continuation differently,
  // so each turn has one `when` per binary (omp: the hidden steer and its "Tokens used" budget line; stub: "(#n)").
  const progress = [{ tool: "bash", args: { command: "echo one" }, result: "one" }, { text: "working" }];
  const finish = [{ text: "all done" }, { goalComplete: true }, { tool: "goal", args: { op: "complete" } }];

  test("between goal turns the parent is not idle: continuation due is isSettled=false with nothing streaming and no async work", async () => {
    rig.setScript({
      turns: [
        { when: "(#2)", steps: finish },
        { when: "Tokens used: 220", steps: finish },
        { when: "session goal is still open", steps: progress },
        { when: "Hidden continuation steer", steps: progress },
      ],
    });
    const m = c.mark();
    // not awaited: the due window is only milliseconds long, polling starts at once
    c.fire({ type: "goal", op: "create", objective: "ship it" });
    const samples = await sampleUntil(m, (s) => s.starts >= 2 && s.ends >= 2 && s.settled, { limitMs: 60_000 });
    await c.settled(m, 60_000);
    await sleep(150);

    // goal create on an idle session: the continuation is decided, not yet admitted
    const due = samples.filter((s) => s.starts === 0 && s.goal === "active");
    expect(due.length).toBeGreaterThanOrEqual(1);
    for (const s of due) {
      expect(tuple(s)).toBe("streaming=false settled=false async=false queued=0");
    }
    // at no point before the stretch closed did get_state say settled, and no background work was ever reported
    const open = samples.filter((s) => !(s.starts >= 2 && s.ends >= 2));
    expect(open.every((s) => !s.settled)).toBe(true);
    expect(samples.every((s) => !s.async)).toBe(true);
    // while a goal turn streams: streaming, not settled
    expect(samples.filter((s) => s.streaming).every((s) => !s.settled && !s.async)).toBe(true);

    const frames = c.frames.slice(m);
    expect(frames.filter((f) => f.type === "agent_start")).toHaveLength(2);
    expect(frames.filter((f) => f.type === "agent_end")).toHaveLength(2);
    expect(frames.filter((f) => f.type === "session_settled")).toHaveLength(1);
    expect(lastEvent(frames).type).toBe("session_settled");
    // goal turns have no prompt of their own to report
    expect(frames.filter((f) => f.type === "prompt_result")).toHaveLength(0);
    const end = await sample(m);
    expect(tuple(end)).toBe("streaming=false settled=true async=false queued=0");
    expect(end.goal).toBeNull(); // completed by the agent's goal tool
  });

  test("goal active + background work: the parent is idle (async=true), the continuation waits, the settled stretch leaves the goal active", async () => {
    rig.setScript({
      turns: [
        { when: "Background job", steps: [{ text: "wake ok" }] },
        { when: "session goal is still open", steps: [{ text: "kicking off" }, { tool: "bash", args: { command: "sleep 2; echo bg", async: true }, result: "bg", asyncMs: 1500 }, { text: "started" }] },
        { when: "Hidden continuation steer", steps: [{ text: "kicking off" }, { tool: "bash", args: { command: "sleep 2; echo bg", async: true }, result: "bg", asyncMs: 1500 }, { text: "started" }] },
      ],
    });
    const m = c.mark();
    expect((await c.send({ type: "goal", op: "create", objective: "background it" })).success).toBe(true);
    await c.waitType("agent_end", { from: m, timeoutMs: 60_000 });
    const gap = await sampleUntil(m, (s) => s.starts >= 2, { pauseMs: 100 });
    const inside = gap.filter((s) => s.starts === 1 && s.ends >= 1);
    expect(inside.length).toBeGreaterThanOrEqual(3);
    for (const s of inside) {
      expect(tuple(s)).toBe("streaming=false settled=false async=true queued=0");
      expect(s.goal).toBe("active");
    }

    await c.settled(m, 60_000);
    await sleep(150);
    const frames = c.frames.slice(m);
    // goal run, then the job's wake run; the wake made no progress, so no further goal turn
    expect(frames.filter((f) => f.type === "agent_start")).toHaveLength(2);
    expect(lastEvent(frames).type).toBe("session_settled");
    const end = await sample(m);
    expect(tuple(end)).toBe("streaming=false settled=true async=false queued=0");
    expect(end.goal).toBe("active");
    await c.send({ type: "goal", op: "drop" });
  });

  test("a background wake that makes progress lets the goal continue: wake run, then the next goal turn, then the stretch closes", async () => {
    const spawn = { text: "kicking off" };
    const job = { tool: "bash", args: { command: "sleep 2; echo bg", async: true }, result: "bg", asyncMs: 1500 };
    const first = [spawn, job, { text: "started" }];
    rig.setScript({
      turns: [
        { when: "Background job", steps: [{ text: "wake" }, { tool: "bash", args: { command: "echo wake-progress" }, result: "x" }, { text: "after wake" }] },
        { when: "(#2)", steps: [{ text: "all done" }, { goalComplete: true }, { tool: "goal", args: { op: "complete" } }] },
        { when: "Tokens used: 440", steps: [{ text: "all done" }, { goalComplete: true }, { tool: "goal", args: { op: "complete" } }] },
        { when: "session goal is still open", steps: first },
        { when: "Hidden continuation steer", steps: first },
      ],
    });
    const m = c.mark();
    expect((await c.send({ type: "goal", op: "create", objective: "background then continue" })).success).toBe(true);
    await c.settled(m, 60_000);
    await sleep(150);
    const frames = c.frames.slice(m);
    // goal turn 1, the job's wake, the continuation the wake's progress allowed
    expect(frames.filter((f) => f.type === "agent_start")).toHaveLength(3);
    expect(frames.filter((f) => f.type === "session_settled")).toHaveLength(1);
    expect(lastEvent(frames).type).toBe("session_settled");
    const end = await sample(m);
    expect(tuple(end)).toBe("streaming=false settled=true async=false queued=0");
    expect(end.goal).toBeNull(); // completed by the agent's goal tool
  });
});

describe(`R10 the third not-idle shape: a stretch stranded by abort (${rig.kind})`, () => {
  test("queued input left behind by a plain abort: isSettled=false, nothing streaming, async=false, queued>0 (no run is due)", async () => {
    const solo = await rig.spawn();
    rig.setScript({ turns: [{ when: "SLOWRUN", steps: [{ text: "working" }, { sleep: 700 }, { text: " more" }] }] });
    const m = solo.mark();
    solo.fire({ type: "prompt", message: "SLOWRUN go" });
    await solo.waitType("agent_start", { from: m });
    await solo.send({ type: "prompt", message: "queued behind", streamingBehavior: "followUp" });
    await solo.send({ type: "abort" });
    await sleep(300);
    const s = await solo.ok<Frame>({ type: "get_state" });
    expect(`streaming=${s.isStreaming} settled=${s.isSettled} async=${s.hasPendingAsyncWork} queued=${s.queuedMessageCount}`).toBe("streaming=false settled=false async=false queued=1");
    expect(must(solo.frames.slice(m).filter((f) => f.type === "agent_start"), "agent_start frames")).toHaveLength(1);
    expect(solo.frames.slice(m).some((f) => f.type === "session_settled")).toBe(false);
  });
});
