// Subagent frames as omp emits them on the parent's stream (task/executor.ts, modes/rpc/rpc-subagents.ts).
// The stub reproduces them for a tool step `{tool:"task", args, subagent:{steps}}`; the real omp runs the
// task tool against the fake provider, whose turn for the assignment text plays the subagent.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { must, Rig, readTranscript, sleep, type OmpChild } from "./harness";

setDefaultTimeout(90_000);

const rig = new Rig();
let c: OmpChild;
beforeAll(async () => { c = await rig.spawn(); });
afterAll(() => rig.close());

const subSteps = [{ text: "subagent working" }, { tool: "read", args: { path: "/etc/hostname" }, result: "box" }, { text: "sub final" }];

describe(`subagent frames (${rig.kind})`, () => {
  test("set_subagent_subscription validates and echoes the level", async () => {
    const r = await c.send({ type: "set_subagent_subscription", level: "events" });
    expect(r.success).toBe(true);
    expect(r.data.level).toBe("events");
    const bad = await c.send({ type: "set_subagent_subscription", level: "loud" });
    expect(bad.success).toBe(false);
    await c.send({ type: "set_subagent_subscription", level: "events" });
  });

  test("a task tool call: detached subagent, lifecycle → progress → events → lifecycle, parent stretch stays open until the wake", async () => {
    rig.setScript({
      turns: [
        { when: "SPAWNIT", steps: [{ text: "delegating" }, { tool: "task", args: { name: "Worker", task: "SUBTASK do the sub thing", solutionSpace: "just reply" }, subagent: { steps: subSteps } } as any, { text: "all done" }] },
        { when: "SUBTASK", steps: subSteps },
      ],
    });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "SPAWNIT" });
    await c.settled(m, 60_000);
    await sleep(150);
    const frames = c.frames.slice(m);
    const shape = c.shape(m);

    // parent: tool call id the subagent hangs off
    const toolStart = must(frames.find((f) => f.type === "tool_execution_start" && f.toolName === "task"), "task tool_execution_start");
    expect(toolStart).toBeTruthy();

    const life = frames.filter((f) => f.type === "subagent_lifecycle");
    expect(life.map((f) => f.payload.status)).toEqual(["started", "completed"]);
    const started = life[0].payload;
    expect(started.id).toBe("Worker");
    expect(started.agent).toBe("task");
    expect(typeof started.index).toBe("number");
    expect(started.parentToolCallId).toBe(toolStart.toolCallId);
    expect(typeof started.sessionFile).toBe("string");
    expect(life[1].payload.sessionFile).toBe(started.sessionFile);

    // the artifact transcript exists and its header carries the child's own session id
    expect(existsSync(started.sessionFile)).toBe(true);
    const header = must(readTranscript(started.sessionFile).find((l) => l.type === "session"), "subagent transcript header");
    expect(typeof header.id).toBe("string");

    const progress = frames.filter((f) => f.type === "subagent_progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((f) => f.payload.progress?.id === "Worker")).toBe(true);
    expect(progress[0].payload.progress.status).toBe("running");
    expect(must(progress.at(-1), "last subagent_progress").payload.progress.status).toBe("completed");
    expect(progress[0].payload.sessionFile).toBe(started.sessionFile);
    expect(progress[0].payload.parentToolCallId).toBe(toolStart.toolCallId);

    const events = frames.filter((f) => f.type === "subagent_event");
    expect(events.every((f) => f.payload.id === "Worker")).toBe(true);
    const types = events.map((f) => f.payload.event.type);
    expect(types[0]).toBe("agent_start");
    expect(types.at(-1)).toBe("agent_end");
    for (const t of ["turn_start", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end", "turn_end"]) expect(types).toContain(t);
    const userStart = must(events.find((f) => f.payload.event.type === "message_start" && f.payload.event.message.role === "user"), "subagent user message_start");
    expect(String(userStart.payload.event.message.content[0].text)).toContain("SUBTASK");
    const delta = must(events.find((f) => f.payload.event.type === "message_update"), "subagent message_update").payload.event.assistantMessageEvent;
    expect(typeof delta.type).toBe("string");
    const finalAssistant = must(events.filter((f) => f.payload.event.type === "message_end" && f.payload.event.message.role === "assistant").at(-1), "subagent assistant message_end");
    expect(finalAssistant.payload.event.message.content[0].text).toBe("sub final");

    // ordering: parent yields first (sessionSettled:false), the subagent runs, its completion wakes the parent, then one session_settled
    const prIdx = shape.findIndex((l) => l.startsWith("prompt_result"));
    const pr = must(frames.find((f) => f.type === "prompt_result"), "prompt_result");
    expect(pr.id).toBe(p1);
    expect(pr.sessionSettled).toBe(false);
    const firstSub = frames.findIndex((f) => f.type === "subagent_lifecycle");
    const lastSub = frames.length - 1 - [...frames].reverse().findIndex((f) => /^subagent_/.test(f.type));
    const prFrame = frames.findIndex((f) => f.type === "prompt_result");
    expect(firstSub).toBeGreaterThan(prFrame);
    const wake = frames.findIndex((f, i) => i > lastSub && f.type === "agent_start");
    expect(wake).toBeGreaterThan(lastSub);
    expect(shape.at(-1)).toBe("session_settled");
    expect(shape.filter((l) => l === "session_settled")).toHaveLength(1);
    expect(prIdx).toBeGreaterThan(-1);

    // finished subagents are no longer listed
    expect((await c.send({ type: "get_subagents" })).data.subagents).toEqual([]);
  });

  test("get_subagents lists a running subagent; cancel_subagent ends it as aborted", async () => {
    rig.setScript({
      turns: [
        { when: "SPAWNHANG", steps: [{ text: "delegating" }, { tool: "task", args: { name: "Sleeper", task: "SUBHANG wait forever", solutionSpace: "wait" }, subagent: { steps: [{ text: "waiting" }, { hang: true }] } } as any, { text: "spawned" }] },
        { when: "SUBHANG", steps: [{ text: "waiting" }, { hang: true }] },
      ],
    });
    const m = c.mark();
    c.fire({ type: "prompt", message: "SPAWNHANG" });
    await c.waitFor((f) => f.type === "subagent_lifecycle" && f.payload.status === "started", { from: m, timeoutMs: 60_000 });
    await c.waitFor((f) => f.type === "subagent_event" && f.payload.event.type === "message_update", { from: m, timeoutMs: 60_000 });
    const listed = (await c.send({ type: "get_subagents" })).data.subagents as any[];
    expect(listed.map((s) => s.id)).toEqual(["Sleeper"]);
    expect(listed[0].status).toBe("running");
    expect(typeof listed[0].sessionFile).toBe("string");
    const steer = await c.send({ type: "steer_subagent", subagentId: "Sleeper", message: "keep going", hostMessageId: "host-sub-steer" });
    expect(steer.success).toBe(true);
    expect((await c.send({ type: "get_queued_prompts", subagentId: "Nobody" })).success).toBe(false);
    expect((await c.send({ type: "get_queued_prompts", subagentId: "Sleeper" })).success).toBe(true);
    expect((await c.send({ type: "set_subagent_model", subagentId: "Sleeper", provider: "fake", modelId: "smart" })).success).toBe(true);
    expect((await c.send({ type: "set_subagent_model", subagentId: "Sleeper", provider: "fake", modelId: "nope" })).success).toBe(false);
    expect((await c.send({ type: "set_subagent_model", subagentId: "Nobody", provider: "fake", modelId: "smart" })).success).toBe(false);
    const cancel = await c.send({ type: "cancel_subagent", subagentId: "Sleeper" });
    expect(cancel.success).toBe(true);
    expect(cancel.data.cancelled).toBe(true);
    const end = await c.waitFor((f) => f.type === "subagent_lifecycle" && f.payload.status !== "started", { from: m, timeoutMs: 60_000 });
    expect(end.payload.status).toBe("aborted");
    await c.settled(m, 60_000);
    expect((await c.send({ type: "get_subagents" })).data.subagents).toEqual([]);
    expect((await c.send({ type: "steer_subagent", subagentId: "Sleeper", message: "late" })).success).toBe(false);
  });
});
