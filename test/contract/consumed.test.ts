// R7: stub fidelity. Every frame field the sidecar reads must be present, with the right type, in the stub
// and in the real omp. The manifest below is the sidecar's actual consumption, read from
//   src/providers/omp/events.ts (handleFrame), src/providers/omp/backend.ts, src/providers/omp/rpc.ts,
//   src/adapters/openchamber/prompt.ts, follow.ts, src/omp/utility.ts
// (see docs/research/R7.md for the per-field citations). A field added to the sidecar belongs here too.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { Rig, writeFileSync, writeFixture, type Frame, type OmpChild } from "./harness";

setDefaultTimeout(90_000);

type Kind = "string" | "number" | "boolean" | "object" | "array" | "any";
const rig = new Rig();
let c: OmpChild;
beforeAll(async () => { c = await rig.spawn(); });
afterAll(() => rig.close());

function at(obj: any, path: string): unknown {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function matches(value: unknown, kind: Kind): boolean {
  if (kind === "any") return value !== undefined;
  if (kind === "array") return Array.isArray(value);
  if (kind === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === kind;
}
function expectFields(label: string, frame: Frame | undefined, fields: Record<string, Kind>) {
  expect(frame, `${label}: frame missing`).toBeTruthy();
  const bad = Object.entries(fields).filter(([p, k]) => !matches(at(frame, p), k)).map(([p, k]) => `${p}:${k} (got ${JSON.stringify(at(frame, p))?.slice(0, 60)})`);
  expect(bad, `${label}: ${bad.join("; ")}`).toEqual([]);
}
const first = (frames: Frame[], pred: (f: Frame) => boolean) => frames.find(pred);

const USAGE = { "usage.input": "number", "usage.output": "number", "usage.cacheRead": "number", "usage.cacheWrite": "number", "usage.totalTokens": "number", "usage.cost": "object" } as const;

describe(`R7 consumed frame fields (${rig.kind})`, () => {
  test("streamed turn frames: text, reasoning, tool", async () => {
    // reasoning needs a reasoning model; the effort pick is the sidecar's `set_thinking_level`
    expect((await c.send({ type: "set_model", provider: "fake", modelId: "smart" })).success).toBe(true);
    expect((await c.send({ type: "set_thinking_level", level: "high" })).success).toBe(true);
    const file = join(rig.project, "note.txt");
    writeFileSync(file, "fixture\n");
    rig.setScript({ turns: [{ when: "CONSUME", steps: [{ thinking: "pondering" }, { text: "looking" }, { tool: "read", args: { path: file }, result: "fixture" }, { text: "done" }] }] });
    const m = c.mark();
    const id = c.fire({ type: "prompt", message: "CONSUME everything" });
    await c.settled(m);
    const frames = c.frames.slice(m);

    expectFields("response", first(frames, (f) => f.type === "response" && f.command === "prompt"), { id: "string", command: "string", success: "boolean" });
    expect(first(frames, (f) => f.type === "response" && f.command === "prompt")!.id).toBe(id);
    expectFields("agent_start", first(frames, (f) => f.type === "agent_start"), { type: "string" });
    expectFields("turn_start", first(frames, (f) => f.type === "turn_start"), { type: "string" });

    // events.ts 11c: user message_start
    expectFields("message_start user", first(frames, (f) => f.type === "message_start" && f.message?.role === "user"), { messageId: "string", "message.role": "string", "message.content": "array", "message.timestamp": "number" });

    // events.ts 1-3: usage/model/telemetry come from the assistant message
    const assistantEnd = first(frames, (f) => f.type === "message_end" && f.message?.role === "assistant");
    expectFields("message_end assistant", assistantEnd, {
      messageId: "string", "message.content": "array", "message.provider": "string", "message.model": "string", "message.stopReason": "string", "message.timestamp": "number",
      ...Object.fromEntries(Object.entries(USAGE).map(([k, v]) => [`message.${k}`, v])),
    });
    expect(assistantEnd!.message.provider).toBe("fake");

    // events.ts 12: deltas
    const upd = frames.filter((f) => f.type === "message_update");
    expectFields("message_update", upd[0], { messageId: "string", "message.role": "string", "assistantMessageEvent.type": "string" });
    const delta = (t: string) => upd.map((f) => f.assistantMessageEvent).find((e) => e.type === t);
    expectFields("text_delta", { assistantMessageEvent: delta("text_delta") }, { "assistantMessageEvent.delta": "string", "assistantMessageEvent.contentIndex": "number" });
    expectFields("thinking_delta", { assistantMessageEvent: delta("thinking_delta") }, { "assistantMessageEvent.delta": "string" });
    expect(delta("text_end")).toBeTruthy();
    expect(delta("thinking_end")).toBeTruthy();
    expectFields("toolcall_start", { assistantMessageEvent: delta("toolcall_start") }, { "assistantMessageEvent.contentIndex": "number" });
    expect(delta("toolcall_delta")).toBeTruthy();
    expectFields("toolcall_end", { assistantMessageEvent: delta("toolcall_end") }, { "assistantMessageEvent.toolCall.id": "string", "assistantMessageEvent.toolCall.name": "string", "assistantMessageEvent.toolCall.arguments": "object" });

    // events.ts 11: tool execution
    const ts = first(frames, (f) => f.type === "tool_execution_start");
    expectFields("tool_execution_start", ts, { toolCallId: "string", toolName: "string", args: "object" });
    expectFields("tool_execution_end", first(frames, (f) => f.type === "tool_execution_end"), { toolCallId: "string", toolName: "string", "result.content": "array", isError: "boolean" });
    expectFields("toolResult message_end", first(frames, (f) => f.type === "message_end" && f.message?.role === "toolResult"), { "message.toolCallId": "string", "message.toolName": "string", "message.content": "array", "message.isError": "boolean" });

    // events.ts 4b/5: turn_end carries the message whose stopReason/errorMessage decide the turn
    expectFields("turn_end", first(frames, (f) => f.type === "turn_end"), { "message.stopReason": "string", "message.role": "string", toolResults: "array" });
    const agentEnd = first(frames, (f) => f.type === "agent_end");
    expectFields("agent_end", agentEnd, { messages: "array", yielded: "boolean", isTerminal: "boolean" });
    expectFields("prompt_result", first(frames, (f) => f.type === "prompt_result"), { id: "string", agentInvoked: "boolean", status: "string", sessionSettled: "boolean" });
    expectFields("session_settled", first(frames, (f) => f.type === "session_settled"), { type: "string" });
  });

  test("queue_update (message-queue / inbox)", async () => {
    rig.setScript({ turns: [{ when: "SLOWRUN", steps: [{ text: "working" }, { sleep: 500 }, { text: " more" }] }] });
    const m = c.mark();
    c.fire({ type: "prompt", message: "SLOWRUN" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    await c.send({ type: "follow_up", message: "next one" });
    await c.settled(m);
    expectFields("queue_update", first(c.frames.slice(m), (f) => f.type === "queue_update"), { steering: "array", followUp: "array", liveSteered: "number" });
  });

  test("get_state", async () => {
    const r = await c.send({ type: "get_state" });
    expect(r.success).toBe(true);
    expectFields("get_state", r, {
      "data.model.provider": "string", "data.model.id": "string", "data.thinkingLevel": "string", "data.isStreaming": "boolean", "data.isCompacting": "boolean",
      "data.sessionFile": "string", "data.sessionId": "string", "data.queuedMessageCount": "number", "data.hasPendingAsyncWork": "boolean", "data.isSettled": "boolean",
      "data.todoPhases": "array", "data.messageCount": "number", "data.queuedMessages.steering": "array", "data.queuedMessages.followUp": "array",
    });
    // goal is `null` or an object in real omp; the sidecar reads `state.goal?.goal`
    expect(r.data.goal === null || typeof r.data.goal === "object").toBe(true);
    expect(r.data.model.provider).toBe("fake");
    expect(r.data.thinkingLevel).toBe("high");
  });

  test("model catalog, commands, messages, entries, lease, subagents", async () => {
    const models = await c.send({ type: "get_available_models" });
    expectFields("get_available_models", models, { "data.models": "array" });
    for (const model of models.data.models) {
      expectFields(`model ${model.id}`, model, { provider: "string", id: "string", name: "string", reasoning: "boolean", contextWindow: "number", maxTokens: "number", input: "array" });
    }
    const cmds = await c.send({ type: "get_available_commands" });
    expect(cmds.success).toBe(true);
    expect(Array.isArray(cmds.data.commands)).toBe(true);
    const msgs = await c.send({ type: "get_messages" });
    expectFields("get_messages", msgs, { "data.messages": "array" });
    expectFields("get_entries", await c.send({ type: "get_entries" }), { "data.entries": "array", "data.leafId": "string" });
    expectFields("get_session_lease", await c.send({ type: "get_session_lease", sessionIds: [] }), { "data.held": "array", "data.unknown": "array" });
    expectFields("get_subagents", await c.send({ type: "get_subagents" }), { "data.subagents": "array" });
    expectFields("get_last_assistant_text", await c.send({ type: "get_last_assistant_text" }), { "data.text": "string" });
    const levels = await c.send({ type: "get_available_thinking_levels" });
    expect(levels.success).toBe(true);
    const ctx = await c.send({ type: "get_context_breakdown" });
    expect(ctx.success).toBe(true);
    expectFields("get_context_breakdown", ctx, { "data.model.provider": "string", "data.model.modelId": "string", "data.contextWindow": "number", "data.categories": "array", "data.usedTokens": "number", "data.freeTokens": "number" });
    expect(ctx.data.categories.every((x: any) => typeof x.id === "string" && typeof x.label === "string" && typeof x.tokens === "number")).toBe(true);
  });

  test("set_model, set_thinking_level, session switch responses", async () => {
    const sm = await c.send({ type: "set_model", provider: "fake", modelId: "fast" });
    expect(sm.success).toBe(true);
    expectFields("set_model", sm, { "data.provider": "string", "data.id": "string" });
    const miss = await c.send({ type: "set_model", provider: "fake", modelId: "nope" });
    expect(miss.success).toBe(false);
    expect(typeof miss.error).toBe("string");
    const fx = writeFixture(rig);
    const sw = await c.send({ type: "switch_session", sessionPath: fx.path });
    expectFields("switch_session", sw, { "data.cancelled": "boolean" });
    // a path that does not exist is not an error: omp opens an empty session that will write there
    const missing = join(rig.root, "missing.jsonl");
    const gone = await c.send({ type: "switch_session", sessionPath: missing });
    expect(gone.success).toBe(true);
    const opened = (await c.send({ type: "get_state" })).data;
    expect(opened.sessionFile).toBe(missing);
    expect(opened.messageCount).toBe(0);
    const name = await c.send({ type: "set_session_name", name: "contract" });
    expect(name.success).toBe(true);
    expect((await c.send({ type: "get_state" })).data.sessionName).toBe("contract");
  });

  test("an unknown command fails with a response, not silence", async () => {
    const r = await c.send({ type: "definitely_not_a_command" });
    expect(r.success).toBe(false);
    expect(typeof r.error).toBe("string");
  });
});
