// R1: the frame order of an activity stretch (PLAN.md §3.1). Runs against the stub and the real omp.
//   CONTRACT_OMP=stub bun test test/contract      (default)
//   CONTRACT_OMP=real bun test test/contract
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { must, readTranscript, Rig, shapeOf, sleep, writeFileSync, type OmpChild } from "./harness";

setDefaultTimeout(90_000);

const PR = (status: string, settled: boolean) => `prompt_result{agentInvoked:true,status:${status},sessionSettled:${settled}}`;
const rig = new Rig();
let c: OmpChild;
beforeAll(async () => { c = await rig.spawn(); });
afterAll(() => rig.close());

const slow = { when: "SLOWRUN", steps: [{ text: "working" }, { sleep: 700 }, { text: " more" }] };
const second = { when: "SECOND", steps: [{ text: "second reply" }] };
const hang = { when: "HANGRUN", steps: [{ text: "start" }, { hang: true }] };

const count = (shape: string[], label: string) => shape.filter((l) => l === label).length;
const firstIndex = (shape: string[], label: string) => shape.indexOf(label);
const userTexts = (frames: any[]) => frames.filter((f) => f.type === "message_start" && f.message?.role === "user").map((f) => String(f.message.content?.[0]?.text ?? ""));
const prResults = (frames: any[]) => frames.filter((f) => f.type === "prompt_result");

/** The stretch is closed: `session_settled` is the last frame and nothing follows it. */
async function expectClosed(from: number) {
  await sleep(150);
  const shape = c.shape(from);
  expect(shape.at(-1)).toBe("session_settled");
  expect(count(shape, "session_settled")).toBe(1);
  expect(count(shape, "agent_start")).toBe(count(shape, "agent_end"));
  return shape;
}

describe(`R1 stretch frame order (${rig.kind})`, () => {
  test("plain turn: response, agent_start … agent_end, prompt_result{sessionSettled:true}, session_settled", async () => {
    rig.setScript({ turns: [] });
    const m = c.mark();
    const r = await c.send({ type: "prompt", message: "plain hello" });
    expect(r.success).toBe(true);
    await c.settled(m);
    const shape = await expectClosed(m);
    expect(shape).toEqual([
      "response:prompt", "agent_start", "turn_start", "message_start:user", "message_end:user", "message_start:assistant", "message_end:assistant",
      "turn_end", "agent_end", PR("completed", true), "session_settled",
    ]);
    const pr = prResults(c.frames.slice(m))[0];
    expect(pr.id).toBe(r.id);
    const assistant = must(c.frames.slice(m).find((f) => f.type === "message_end" && f.message.role === "assistant"), "assistant message_end");
    expect(assistant.message.stopReason).toBe("stop");
    // message lifecycle frames share one messageId (rpc-types.ts RpcMessageEventFrame)
    const mids = c.frames.slice(m).filter((f) => f.type.startsWith("message_")).map((f) => f.messageId);
    expect(mids.every((x) => typeof x === "string" && x.length > 0)).toBe(true);
  });

  test("tool turn: one agent_start, two turns around the tool result", async () => {
    const file = join(rig.project, "note.txt");
    writeFileSync(file, "hello from the fixture\n");
    rig.setScript({ turns: [{ when: "TOOLRUN", steps: [{ text: "looking" }, { tool: "read", args: { path: file }, result: "hello from the fixture" }, { text: "done reading" }] }] });
    const m = c.mark();
    await c.send({ type: "prompt", message: "TOOLRUN please" });
    await c.settled(m);
    const shape = await expectClosed(m);
    expect(shape).toEqual([
      "response:prompt", "agent_start", "turn_start", "message_start:user", "message_end:user", "message_start:assistant", "message_end:assistant",
      "tool_execution_start", "tool_execution_end", "message_start:toolResult", "message_end:toolResult", "turn_end",
      "turn_start", "message_start:assistant", "message_end:assistant", "turn_end", "agent_end", PR("completed", true), "session_settled",
    ]);
    const start = must(c.frames.slice(m).find((f) => f.type === "tool_execution_start"), "tool_execution_start");
    const end = must(c.frames.slice(m).find((f) => f.type === "tool_execution_end"), "tool_execution_end");
    expect(start.toolName).toBe("read");
    expect(end.toolCallId).toBe(start.toolCallId);
    expect(end.isError).toBe(false);
    expect(Array.isArray(end.result.content)).toBe(true);
    const firstAssistant = must(c.frames.slice(m).find((f) => f.type === "message_end" && f.message.role === "assistant"), "assistant message_end");
    expect(firstAssistant.message.stopReason).toBe("toolUse");
  });

  test("follow-up queued mid-turn via prompt{streamingBehavior} stays in one stretch", async () => {
    rig.setScript({ turns: [slow, second] });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "SLOWRUN one" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    const r2 = await c.send({ type: "prompt", message: "SECOND one", streamingBehavior: "followUp" });
    expect(r2.success).toBe(true);
    await c.settled(m);
    const shape = await expectClosed(m);
    expect(count(shape, "agent_start")).toBe(1);
    expect(count(shape, "agent_end")).toBe(1);
    const frames = c.frames.slice(m);
    expect(userTexts(frames).map((t) => t.includes("SLOWRUN") ? "first" : t.includes("SECOND") ? "second" : t)).toEqual(["first", "second"]);
    const queue = frames.filter((f) => f.type === "queue_update");
    expect(queue.some((f) => (f.followUp as string[]).some((t) => t.includes("SECOND")))).toBe(true);
    // both prompts report after the single agent_end, before session_settled
    const results = prResults(frames);
    expect(results.map((r) => r.id).sort()).toEqual([p1, r2.id].sort());
    for (const r of results) { expect(r.status).toBe("completed"); expect(r.sessionSettled).toBe(true); }
    const agentEnd = firstIndex(shape, "agent_end");
    expect(shape.slice(0, agentEnd).some((l) => l.startsWith("prompt_result"))).toBe(false);
  });

  test("follow_up command mid-turn: same stretch, no prompt_result of its own", async () => {
    rig.setScript({ turns: [slow, second] });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "SLOWRUN two" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    const r = await c.send({ type: "follow_up", message: "SECOND two" });
    expect(r.success).toBe(true);
    const state = (await c.send({ type: "get_state" })).data;
    expect(state.queuedMessageCount).toBe(1);
    expect(state.queuedMessages.followUp.some((t: string) => t.includes("SECOND"))).toBe(true);
    await c.settled(m);
    const shape = await expectClosed(m);
    expect(count(shape, "agent_start")).toBe(1);
    const frames = c.frames.slice(m);
    expect(prResults(frames).map((x) => x.id)).toEqual([p1]);
    expect(userTexts(frames)).toHaveLength(2);
  });

  test("steer mid-turn: delivered at the next turn boundary inside the same run", async () => {
    rig.setScript({ turns: [slow, { when: "STEERED", steps: [{ text: "ack steer" }] }] });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "SLOWRUN three" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    const r = await c.send({ type: "steer", message: "STEERED now" });
    expect(r.success).toBe(true);
    await c.settled(m);
    const shape = await expectClosed(m);
    expect(count(shape, "agent_start")).toBe(1);
    expect(count(shape, "message_end:assistant")).toBe(2);
    const frames = c.frames.slice(m);
    const users = frames.filter((f) => f.type === "message_start" && f.message?.role === "user");
    expect(users).toHaveLength(2);
    expect(users[1].message.steering).toBe(true);
    // the steer is delivered after the first assistant message has ended
    const firstAssistantEnd = shape.indexOf("message_end:assistant");
    const steerStart = shape.indexOf("message_start:user", shape.indexOf("message_start:user") + 1);
    expect(steerStart).toBeGreaterThan(firstAssistantEnd);
    expect(prResults(frames).map((x) => x.id)).toEqual([p1]);
  });

  test("abort: agent_end, then the abort response, prompt_result{aborted}, session_settled", async () => {
    rig.setScript({ turns: [hang] });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "HANGRUN" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    const r = await c.send({ type: "abort" });
    expect(r.success).toBe(true);
    await c.settled(m);
    const shape = await expectClosed(m);
    const ae = shape.indexOf("agent_end");
    const ar = shape.indexOf("response:abort");
    const pr = shape.indexOf(PR("aborted", true));
    expect(ae).toBeGreaterThan(-1);
    expect(ar).toBeGreaterThan(ae);
    expect(pr).toBeGreaterThan(ar);
    expect(shape.at(-1)).toBe("session_settled");
    const frames = c.frames.slice(m);
    expect(prResults(frames)[0].id).toBe(p1);
    const assistant = must(frames.find((f) => f.type === "message_end" && f.message.role === "assistant"), "assistant message_end");
    expect(assistant.message.stopReason).toBe("aborted");
  });

  test("abort with input still queued strands the stretch; abort_and_restore_queue then returns it", async () => {
    rig.setScript({ turns: [hang, second] });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "HANGRUN queued" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    const p2 = await c.send({ type: "prompt", message: "SECOND stranded", streamingBehavior: "followUp" });
    await c.send({ type: "abort" });
    await c.waitFor((f) => f.type === "prompt_result" && f.id === p1, { from: m });
    await sleep(700);
    // omp keeps the queued follow-up: the session is neither streaming nor settled and never emits session_settled
    const frames = c.frames.slice(m);
    expect(frames.some((f) => f.type === "session_settled")).toBe(false);
    expect(prResults(frames).find((r) => r.id === p1).sessionSettled).toBe(false);
    const stuck = (await c.send({ type: "get_state" })).data;
    expect(stuck.isStreaming).toBe(false);
    expect(stuck.isSettled).toBe(false);
    expect(stuck.queuedMessageCount).toBe(1);

    const restored = await c.send({ type: "abort_and_restore_queue" });
    expect(restored.success).toBe(true);
    expect(restored.data.steering).toEqual([]);
    expect(restored.data.followUp).toHaveLength(1);
    expect(String(restored.data.followUp[0].text)).toContain("SECOND stranded");
    const after = (await c.send({ type: "get_state" })).data;
    expect(after.isSettled).toBe(true);
    expect(after.queuedMessageCount).toBe(0);

    // the prompt still owes its prompt_result; it is reported with the next run
    rig.setScript({ turns: [] });
    const m2 = c.mark();
    const p3 = await c.send({ type: "prompt", message: "plain after strand" });
    await c.settled(m2);
    const ids = prResults(c.frames.slice(m2)).map((r) => r.id);
    expect(ids).toContain(p3.id);
    expect(ids).toContain(p2.id);
    // the stranded text never ran
    expect(JSON.stringify(c.frames.slice(m))).not.toContain("second reply");
  });

  test("abort_and_restore_queue mid-run: queue returned, one stretch, queued text never runs", async () => {
    rig.setScript({ turns: [hang, second] });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "HANGRUN restore" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    const p2 = await c.send({ type: "prompt", message: "SECOND queued", streamingBehavior: "followUp" });
    expect((await c.send({ type: "steer", message: "STEERED queued" })).success).toBe(true);
    const r = await c.send({ type: "abort_and_restore_queue" });
    expect(r.success).toBe(true);
    expect(r.data.steering.map((x: any) => String(x.text)).join()).toContain("STEERED queued");
    expect(r.data.followUp.map((x: any) => String(x.text)).join()).toContain("SECOND queued");
    await c.settled(m);
    const shape = await expectClosed(m);
    expect(count(shape, "agent_start")).toBe(1);
    const frames = c.frames.slice(m);
    const results = prResults(frames);
    expect(results.map((x) => x.id).sort()).toEqual([p1, p2.id].sort());
    for (const x of results) { expect(x.status).toBe("aborted"); expect(x.sessionSettled).toBe(true); }
    expect(userTexts(frames)).toHaveLength(1);
    const state = (await c.send({ type: "get_state" })).data;
    expect(state.queuedMessageCount).toBe(0);
  });

  test("abort_and_prompt: the old run yields aborted, the new run starts before the old prompt reports, one session_settled at the end", async () => {
    rig.setScript({ turns: [hang, { when: "REPLACE", steps: [{ text: "replaced" }] }] });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "HANGRUN replaced soon" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    const r = await c.send({ type: "abort_and_prompt", message: "REPLACE it" });
    expect(r.success).toBe(true);
    await c.settled(m);
    const shape = await expectClosed(m);
    expect(count(shape, "agent_start")).toBe(2);
    const frames = c.frames.slice(m);
    const results = prResults(frames);
    expect(results.map((x) => x.id)).toEqual([p1, r.id]);
    expect(results[0].status).toBe("aborted");
    expect(results[0].sessionSettled).toBe(false); // the replacement run is already live
    expect(results[1].status).toBe("completed");
    expect(results[1].sessionSettled).toBe(true);
    const firstEnd = shape.indexOf("agent_end");
    expect(shape.indexOf("response:abort_and_prompt")).toBeGreaterThan(firstEnd);
    expect(shape.indexOf("agent_start", firstEnd)).toBeGreaterThan(firstEnd);
  });

  test("a background job wakes the session inside the stretch: prompt_result{sessionSettled:false}, second run, one session_settled", async () => {
    rig.setScript({
      turns: [{ when: "ASYNCRUN", steps: [{ text: "starting" }, { tool: "bash", args: { command: "sleep 0.5; echo job-done", async: true }, result: "job-done", asyncMs: 500 }, { text: "job started" }] }],
    });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "ASYNCRUN go" });
    await c.settled(m, 60_000);
    const shape = await expectClosed(m);
    expect(count(shape, "agent_start")).toBe(2);
    const frames = c.frames.slice(m);
    const first = prResults(frames).find((r) => r.id === p1);
    expect(first.sessionSettled).toBe(false);
    // the wake run starts after the first prompt_result and before session_settled
    const firstPr = shape.indexOf(PR("completed", false));
    const secondStart = shape.indexOf("agent_start", firstPr);
    expect(secondStart).toBeGreaterThan(firstPr);
    expect(frames.some((f) => f.type === "message_start" && f.message?.role === "custom")).toBe(true);
    const transcript = readTranscript(((await c.send({ type: "get_state" })).data.sessionFile as string));
    expect(transcript.some((l) => l.type === "custom_message")).toBe(true);
  });

  test("a local command (no agent turn) opens no stretch", async () => {
    // an unknown slash command never reaches the model in real omp; keep to the model-free surface: empty-input prompts
    const m = c.mark();
    const r = await c.send({ type: "prompt", message: "   " });
    expect(r.success).toBe(true);
    expect(r.data?.agentInvoked).toBe(false);
    await sleep(200);
    const shape = c.shape(m);
    expect(shape).toEqual(["response:prompt"]);
    expect(shapeOf(c.frames.slice(m)).includes("session_settled")).toBe(false);
  });
});
