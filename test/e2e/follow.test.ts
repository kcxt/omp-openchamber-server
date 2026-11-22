import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OmpInstance } from "./omp";
import { startStack, type Stack } from "./stack";
import { appendFileSync } from "node:fs";

let stack: Stack;
beforeAll(async () => { stack = await startStack({ env: { OC_FOLLOW_POLL_MS: "100" } }); });
afterAll(() => stack.stop());

const dir = () => encodeURIComponent(stack.project);

/** Collects the sidecar's v2 event stream until stopped. */
function collect() {
  const events: any[] = [];
  const ctl = new AbortController();
  const done = fetch(`${stack.api}/event?directory=${dir()}`, { signal: ctl.signal }).then(async (res) => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as any) {
      buf += decoder.decode(chunk);
      const frames = buf.split("\n\n");
      buf = frames.pop()!;
      for (const frame of frames) {
        const data = frame.split("\n").find((l) => l.startsWith("data:"));
        if (data) try { events.push(JSON.parse(data.slice(5))); } catch { /* keepalive */ }
      }
    }
  }).catch(() => {});
  return { events, stop: async () => { ctl.abort(); await done; } };
}

const until = async (what: string, probe: () => boolean | Promise<boolean>, ms = 15_000) => {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};

describe("a session a terminal omp owns is followed live", () => {
  test("messages the terminal appends arrive as events, with busy/idle around them", async () => {
    stack.script([{ when: "slow", steps: [{ thinking: "pondering" }, { sleep: 600 }, { text: "Slow answer." }] }]);
    const terminal = await OmpInstance.start(stack, stack.project);
    await terminal.prompt("first from terminal");
    const id = ((await stack.http(`/session?directory=${dir()}`)).body.data as any[]).find((s) => s.title === "first from terminal").id;

    // OpenChamber opening the session is what starts the follow.
    expect(((await stack.http(`/session/${id}/message?directory=${dir()}`)).body.data as any[]).length).toBeGreaterThan(0);
    const stream = collect();
    await Bun.sleep(300);

    const turn = terminal.prompt("slow please");
    // A held lease with a tail mid-turn is busy for as long as the terminal works.
    await until("busy", async () => (await stack.http(`/session/status?directory=${dir()}`)).body?.[id]?.type === "busy");
    await turn;
    await until("followed text", () => stream.events.some((e) => e.type === "session.text.ended" && String(e.data?.text).includes("Slow answer.")));
    await until("idle", () => stream.events.some((e) => e.type === "session.execution.succeeded" && e.data?.sessionID === id));
    await stream.stop();
    // The terminal still holds the lease, but its tail is settled: idle.
    expect((await stack.http(`/session/status?directory=${dir()}`)).body?.[id]).toBeUndefined();

    const types = stream.events.map((e) => e.type);
    expect(stream.events.some((e) => e.type === "session.inbox.enqueued" && e.data?.item?.payload?.text === "slow please")).toBe(true);
    expect(types).toContain("session.execution.started");
    expect(types).toContain("session.reasoning.ended");
    expect(types.indexOf("session.execution.started")).toBeLessThan(types.indexOf("session.execution.succeeded"));
    // Read-only: following never wrote or forked anything.
    expect(stack.sessionFiles().filter((f) => JSON.stringify(f.records).includes("slow please")).length).toBe(1);
    await terminal.close();
  });

  test("each part of a growing turn is announced once, a tool call opening as pending", async () => {
    stack.script([{ when: "grow", steps: [
      { thinking: "first thought" },
      { tool: "bash", args: { command: "echo one" }, result: "one" },
      { sleep: 500 },
      { thinking: "second thought" },
      { tool: "bash", args: { command: "echo two" }, result: "two" },
      { sleep: 500 },
      { text: "Grown answer." },
    ] }]);
    const terminal = await OmpInstance.start(stack, stack.project);
    await terminal.prompt("seed grow");
    const id = ((await stack.http(`/session?directory=${dir()}`)).body.data as any[]).find((s) => s.title === "seed grow").id;
    await stack.http(`/session/${id}/message?directory=${dir()}`);
    const stream = collect();
    await Bun.sleep(300);

    await terminal.prompt("grow please");
    await until("final text", () => stream.events.some((e) => e.type === "session.text.ended" && String(e.data?.text).includes("Grown answer.")));
    await stream.stop();

    // OpenChamber stamps a re-sent reasoning part with the event's own time, so a part repeated at every growth
    // of its message would have its duration rewritten each time.
    const keyOf = (e: any) => `${e.type} ${e.data?.assistantMessageID} ${e.data?.ordinal ?? e.data?.id}`;
    const announced = stream.events.filter((e) => ["session.reasoning.ended", "session.text.ended", "session.tool.success"].includes(e.type)).map(keyOf);
    expect(announced.length).toBe(5);
    expect(new Set(announced).size).toBe(announced.length);
    // OpenChamber only advances a tool part it holds: a call that is first heard of as running or done is dropped.
    for (const called of stream.events.filter((e) => e.type === "session.tool.called")) {
      const opened = stream.events.findIndex((e) => e.type === "session.tool.input.started" && e.data?.id === called.data.id);
      expect(opened).toBeGreaterThanOrEqual(0);
      expect(opened).toBeLessThan(stream.events.indexOf(called));
    }
    await terminal.close();
  });
});

describe("a dead turn left in a transcript stays idle", () => {
  let dead: Stack;
  beforeAll(async () => { dead = await startStack({ env: { OC_FOLLOW_POLL_MS: "100" } }); });
  afterAll(() => dead.stop());

  test("a mid-turn tail with no live owner is never reported busy", async () => {
    const deadDir = encodeURIComponent(dead.project);
    const terminal = await OmpInstance.start(dead, dead.project);
    await terminal.prompt("seed dead turn");
    await terminal.close();

    const file = dead.sessionFiles().find((f) => JSON.stringify(f.records).includes("seed dead turn"))!;
    const messages = file.records.filter((r) => r.type === "message");
    const lastAssistant = [...messages].reverse().find((r) => r.message?.role === "assistant")!;
    const id = ((await dead.http(`/session?directory=${deadDir}`)).body.data as any[]).find((s) => s.title === "seed dead turn").id;
    const busy = async () => (await dead.http(`/session/status?directory=${deadDir}`)).body?.[id]?.type === "busy";

    // A tool call with no result: the turn is dead, and no omp owns the transcript.
    const dangling = structuredClone(lastAssistant);
    dangling.id = "deadturn00000001";
    dangling.parentId = messages.at(-1)!.id;
    dangling.timestamp = new Date().toISOString();
    dangling.message.timestamp = Date.now();
    dangling.message.content = [{ type: "toolCall", id: "toolu_dead", name: "bash", arguments: { command: "sleep 999" } }];
    dangling.message.stopReason = "toolUse";
    appendFileSync(file.path, JSON.stringify(dangling) + "\n");

    // The file keeps growing, as the OpenChamber turn heartbeat makes it do.
    const heartbeat = setInterval(() => appendFileSync(file.path, JSON.stringify({ type: "metadata", metadata: { openchamber: { turn: { endedAt: Date.now(), durationMs: 31000 } } }, timestamp: new Date().toISOString() }) + "\n"), 100);
    // OpenChamber reads the session on open and again at every busy → idle it sees. A dead tail
    // must never be reported busy, however often it is read: reported busy until the ownership
    // probe finished (seconds with a real omp), it made OpenChamber log a turn per read, forever.
    const busySamples: boolean[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        await dead.http(`/session/${id}/message?directory=${deadDir}`);
        const until = Date.now() + 1_000;
        while (Date.now() < until) {
          busySamples.push(await busy());
          await Bun.sleep(50);
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
    expect(busySamples.length).toBeGreaterThan(40);
    expect(busySamples.filter(Boolean).length).toBe(0);
  });
});
