// The session runtime's busy model (PLAN §3.1, §3.4, §3.14) as OpenChamber sees it over the event stream.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "./stack";

const TICK_MS = 40;

let stack: Stack;
beforeAll(async () => { stack = await startStack({ env: { OMP_STUB_TICK_MS: String(TICK_MS) } }); });
afterAll(() => stack.stop());

const dir = () => `directory=${encodeURIComponent(stack.project)}`;
const createSession = async (): Promise<string> => (await stack.http(`/session?${dir()}`, { json: {} })).body.data.id;
const prompt = (id: string, body: Record<string, unknown>) => stack.http(`/session/${id}/prompt_async?${dir()}`, { json: body });
const statusMap = async (): Promise<Record<string, { type: string }>> => (await stack.http(`/session/status?${dir()}`)).body;

type Recorded = { type: string; data: any; at: number };

/** Every v2 event of the sidecar's stream, with its arrival time. */
async function record() {
  const events: Recorded[] = [];
  const ctl = new AbortController();
  const done = fetch(`${stack.api}/event?${dir()}`, { signal: ctl.signal }).then(async (res) => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as any) {
      buf += decoder.decode(chunk);
      const frames = buf.split("\n\n");
      buf = frames.pop()!;
      for (const frame of frames) {
        const data = frame.split("\n").find((l) => l.startsWith("data:"));
        if (data) try { const e = JSON.parse(data.slice(5)); events.push({ type: e.type, data: e.data, at: Date.now() }); } catch { /* keepalive */ }
      }
    }
  }).catch(() => {});
  await Bun.sleep(300);
  return {
    events,
    of: (sessionID: string, type: string) => events.filter((e) => e.type === type && e.data?.sessionID === sessionID),
    /** The session went idle: v2 reports it as the execution's outcome (`session.idle` only after a failure). */
    ended: (sessionID: string) => events.filter((e) => e.data?.sessionID === sessionID
      && ["session.execution.succeeded", "session.execution.interrupted", "session.idle"].includes(e.type)),
    async until(what: string, probe: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
      const start = Date.now();
      while (!(await probe())) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(50);
      }
    },
    async stop() { ctl.abort(); await done; },
  };
}

describe("one busy period per omp run", () => {
  test("a steer and a follow-up sent during a run join it: one busy, one idle", async () => {
    stack.script([
      { when: "long run", steps: [{ text: "working " }, { sleep: 1_500 }, { text: "done" }] },
      { when: "steer me", steps: [{ text: "steered" }] },
      { when: "later", steps: [{ text: "followed" }] },
    ]);
    const id = await createSession();
    const rec = await record();
    await prompt(id, { id: "msg_runtimeA0001", parts: [{ type: "text", text: "long run" }] });
    await rec.until("the run to stream", () => rec.of(id, "session.text.delta").length > 0);
    await prompt(id, { id: "msg_runtimeA0002", parts: [{ type: "text", text: "steer me" }], delivery: "steer" });
    await prompt(id, { id: "msg_runtimeA0003", parts: [{ type: "text", text: "later" }], delivery: "queue" });
    await rec.until("idle", () => rec.ended(id).length > 0);
    await Bun.sleep(500);
    await rec.stop();

    expect(rec.of(id, "session.execution.started").length).toBe(1);
    expect(rec.ended(id).length).toBe(1);
    expect(rec.of(id, "session.inbox.delivered").map((e) => e.data.inboxID).sort()).toEqual(["msg_runtimeA0001", "msg_runtimeA0002", "msg_runtimeA0003"]);
    const sent = stack.frames().filter((f) => f.type === "prompt" && ["steer me", "later"].includes(f.message));
    expect(sent.map((f) => [f.message, f.streamingBehavior, f.hostMessageId])).toEqual([
      ["steer me", "steer", "msg_runtimeA0002"],
      ["later", "followUp", "msg_runtimeA0003"],
    ]);
    expect((await statusMap())[id]).toBeUndefined();
  });
});

describe("Esc", () => {
  test("with queued input: the withdrawn text comes back unsent and the session goes idle", async () => {
    stack.script([{ when: "hold on", steps: [{ text: "holding " }, { sleep: 20_000 }, { text: "never" }] }]);
    const id = await createSession();
    const rec = await record();
    await prompt(id, { id: "msg_runtimeB0001", parts: [{ type: "text", text: "hold on" }] });
    await rec.until("the run to stream", () => rec.of(id, "session.text.delta").length > 0);
    await prompt(id, { id: "msg_runtimeB0002", parts: [{ type: "text", text: "queued one" }], delivery: "queue" });
    await Bun.sleep(200);

    const res = await stack.http(`/session/${id}/interrupt?${dir()}`, { method: "POST" });
    expect(res.body.interrupted).toBe(true);
    expect(res.body.withdrawn).toEqual({ steering: [], followUp: ["queued one"] });
    await rec.until("idle", () => rec.ended(id).length > 0, 6_000);
    await rec.stop();

    expect(rec.of(id, "session.inbox.cancelled").map((e) => e.data.inboxID)).toEqual(["msg_runtimeB0002"]);
    expect((await statusMap())[id]).toBeUndefined();
    expect(stack.frames().some((f) => f.type === "abort_and_restore_queue")).toBe(true);
    // The withdrawn message never reached omp's transcript.
    const messages = (await stack.http(`/session/${id}/message?${dir()}&order=asc`)).body.data as any[];
    expect(messages.filter((m) => m.type === "user").map((m) => m.text)).toEqual(["hold on"]);
  });

  test("while a background subagent runs: the parent goes idle, the child session stays busy", async () => {
    stack.script([{
      when: "delegate",
      steps: [
        { tool: "task", args: { name: "Background", task: "wait for a while" }, subagent: { steps: [{ hang: true }] } } as any,
        { text: "delegated, still talking " },
        { sleep: 20_000 },
      ],
    }]);
    const id = await createSession();
    const rec = await record();
    await prompt(id, { parts: [{ type: "text", text: "delegate it" }] });
    await rec.until("the subagent to run", async () => (await stack.http(`/experimental/job?sessionID=${id}&status=running`)).body.data.length > 0);
    const [job] = (await stack.http(`/experimental/job?sessionID=${id}&status=running`)).body.data;
    expect(job).toMatchObject({ kind: "subagent", sessionID: id, status: "running" });
    const child = job.childSessionID as string;
    await rec.until("the parent to stream past the spawn", () => rec.of(id, "session.text.delta").length > 0);

    const res = await stack.http(`/session/${id}/interrupt?${dir()}`, { method: "POST" });
    expect(res.body.interrupted).toBe(true);
    await rec.until("the parent to go idle", () => rec.ended(id).length > 0, 6_000);
    const status = await statusMap();
    expect(status[id]).toBeUndefined();
    expect(status[child]).toEqual({ type: "busy" });
    expect(stack.frames().some((f) => f.type === "cancel_subagent")).toBe(false);

    // Stopping the child is its own Esc.
    expect((await stack.http(`/session/${child}/abort?${dir()}`, { method: "POST" })).body).toBe(true);
    await rec.until("the child to go idle", () => rec.ended(child).length > 0);
    await rec.stop();
    expect((await statusMap())[child]).toBeUndefined();
  });
});

describe("subagent sessions", () => {
  test("a subagent of a session OpenChamber created keeps that session as its parent after a restart", async () => {
    stack.script([{ when: "spawn", steps: [{ tool: "task", args: { name: "Helper", task: "help" }, subagent: { steps: [{ text: "helped" }] } } as any, { text: "spawned" }] }]);
    // OpenChamber mints its own ids: the parent's id is an alias, not derived from omp's UUID.
    const id = (await stack.http(`/session?${dir()}`, { json: { id: "ses_dfe956dcbffeAliasParent01" } })).body.data.id;
    expect(id).toBe("ses_dfe956dcbffeAliasParent01");
    const rec = await record();
    await prompt(id, { parts: [{ type: "text", text: "spawn a helper" }] });
    await rec.until("the parent's run to end", () => rec.ended(id).length > 0, 15_000);
    await rec.stop();
    const childrenOf = async () => ((await stack.http(`/session?${dir()}`)).body.data as any[]).filter((s) => s.title === "Helper");
    expect((await childrenOf()).map((s) => s.parentID)).toEqual([id]);

    // A fresh sidecar lists the child from disk: its parent is still the alias OpenChamber knows.
    await stack.restartSidecar();
    const [child] = await childrenOf();
    expect(child?.parentID).toBe(id);
    expect((await stack.http(`/session/${child.id}?${dir()}`)).body.data.parentID).toBe(id);
    expect(((await stack.http(`/session/${id}/children?${dir()}`)).body as any[]).map((s) => s.id)).toEqual([child.id]);
  });
});

describe("resume", () => {
  test("`.` continues through omp's resume: no `.` prompt reaches the model, the transcript shows the marker", async () => {
    stack.script([]);
    const id = await createSession();
    const rec = await record();
    await prompt(id, { parts: [{ type: "text", text: "first words" }] });
    await rec.until("idle", () => rec.ended(id).length > 0);
    const before = rec.ended(id).length;
    await prompt(id, { id: "msg_runtimeC0001", parts: [{ type: "text", text: "." }] });
    await rec.until("the continuation to finish", () => rec.ended(id).length > before);
    await rec.stop();

    const frames = stack.frames();
    expect(frames.some((f) => f.type === "resume" && f.hostMessageId === "msg_runtimeC0001" && f.subagentId === undefined)).toBe(true);
    expect(frames.some((f) => f.type === "prompt" && f.message === ".")).toBe(false);
    const messages = (await stack.http(`/session/${id}/message?${dir()}&order=asc`)).body.data as any[];
    const users = messages.filter((m) => m.type === "user");
    expect(users.map((m) => [m.id, m.text])).toEqual([[users[0].id, "first words"], ["msg_runtimeC0001", "."]]);
    expect(messages.at(-1)?.type).not.toBe("user");
    // omp's continue directive is readable, as a `developer` tool card in the reply, not as a user message.
    const reply = JSON.stringify(messages.at(-1));
    expect(reply).toContain("developer");
    expect(reply).toContain("Continue.");
  });
});

describe("streaming latency", () => {
  test("each reasoning delta omp streams goes out on its own, as it arrives", async () => {
    const thinking = "one two three four five six seven eight nine ten eleven twelve";
    stack.script([{ when: "ponder", steps: [{ thinking }, { text: "ok" }] }]);
    const id = await createSession();
    const rec = await record();
    await prompt(id, { parts: [{ type: "text", text: "ponder this" }] });
    await rec.until("the answer", () => rec.of(id, "session.text.ended").length > 0);
    await rec.stop();

    const deltas = rec.of(id, "session.reasoning.delta");
    // The stub sends 6-character chunks, one per tick.
    expect(deltas.length).toBe(Math.ceil(thinking.length / 6));
    expect(deltas.map((e) => e.data.delta).join("")).toBe(thinking);
    const gaps = deltas.slice(1).map((e, i) => e.at - deltas[i]!.at);
    // Batching would show up as runs of near-zero gaps; spacing follows the stub's tick.
    expect(gaps.filter((gap) => gap >= TICK_MS / 2).length).toBeGreaterThanOrEqual(Math.floor(gaps.length * 0.8));
    expect(deltas.at(-1)!.at - deltas[0]!.at).toBeGreaterThanOrEqual((deltas.length - 1) * TICK_MS * 0.6);
  });
});
