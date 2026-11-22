// P5: `resume {subagentId?, hostMessageId?}` is the TUI's `.`: AgentSession.resume() on the session or a subagent, no user
// message journaled, a `host-resume` custom entry first when `hostMessageId` is given. Runs against the stub and the real omp.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { must, readTranscript, Rig, sleep, type Frame, type OmpChild } from "./harness";

setDefaultTimeout(120_000);

const rig = new Rig();
afterAll(() => rig.close());

const slow = { when: "SLOWRUN", steps: [{ text: "working" }, { sleep: 1500 }, { text: " more" }] };
const hang = { when: "HANGRUN", steps: [{ hang: true }] };

const entriesOf = async (c: OmpChild) => (await c.ok<{ entries: Frame[] }>({ type: "get_entries" })).entries;
const userCount = async (c: OmpChild) => (await entriesOf(c)).filter((e) => e.type === "message" && e.message?.role === "user").length;
const markers = async (c: OmpChild) => (await entriesOf(c)).filter((e) => e.type === "custom" && e.customType === "host-resume");
const idxOf = (frames: Frame[], type: string, from = 0) => frames.findIndex((f, i) => i >= from && f.type === type);
const lastIdx = (frames: Frame[], type: string) => frames.length - 1 - [...frames].reverse().findIndex((f) => f.type === type);

describe(`P5 resume on the session (${rig.kind})`, () => {
  test("idle: a hidden directive runs a new turn; the marker is a custom entry; no user message, no prompt_result", async () => {
    const c = await rig.spawn();
    rig.setScript({ turns: [] });
    let m = c.mark();
    await c.send({ type: "prompt", message: "hello" });
    await c.settled(m);
    const users = await userCount(c);

    m = c.mark();
    const r = await c.send({ type: "resume", hostMessageId: "dot-1" });
    expect(r.success).toBe(true);
    await c.settled(m);
    const frames = c.frames.slice(m);

    // omp answers `resume` when the continuation has finished: after agent_end, before session_settled
    expect(frames.filter((f) => f.type === "agent_start")).toHaveLength(1);
    expect(idxOf(frames, "response")).toBeGreaterThan(idxOf(frames, "agent_end"));
    expect(idxOf(frames, "response")).toBeLessThan(idxOf(frames, "session_settled"));
    expect(frames.filter((f) => f.type === "prompt_result")).toHaveLength(0);

    expect(frames.filter((f) => f.type === "message_start" && f.message?.role === "user")).toHaveLength(0);
    const directive = must(frames.find((f) => f.type === "message_start" && f.message?.role === "developer"), "directive message");
    expect(directive.message.synthetic).toBe(true);
    expect(String(directive.message.content[0].text)).toContain("Continue.");
    expect(frames.filter((f) => f.type === "message_start" && f.message?.role === "assistant").length).toBeGreaterThan(0);

    expect(await userCount(c)).toBe(users);
    const found = await markers(c);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ type: "custom", customType: "host-resume", data: { hostMessageId: "dot-1", text: "." } });
    expect(found[0]!.id).toBeTruthy();
    expect(found[0]!.parentId).toBeTruthy();
    // the tail is an assistant message: the continuation follows the marker
    const msgs = (await c.ok<{ messages: Frame[] }>({ type: "get_messages" })).messages;
    expect(msgs.at(-1)!.role).toBe("assistant");

    if (rig.kind === "real") {
      const sent = JSON.stringify(rig.fake.requests);
      expect(sent).not.toContain("host-resume");
      expect(sent).not.toContain("dot-1");
    }
  });

  test("without hostMessageId nothing is journaled but the continuation", async () => {
    const c = await rig.spawn();
    rig.setScript({ turns: [] });
    let m = c.mark();
    await c.send({ type: "prompt", message: "hello" });
    await c.settled(m);
    m = c.mark();
    expect((await c.send({ type: "resume" })).success).toBe(true);
    await c.settled(m);
    expect(await markers(c)).toEqual([]);
  });

  test("streaming: the run is interrupted and continued; the old prompt reports aborted; one stretch", async () => {
    const c = await rig.spawn();
    rig.setScript({ turns: [slow] });
    const m = c.mark();
    const p1 = c.fire({ type: "prompt", message: "SLOWRUN go" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    const r = await c.send({ type: "resume", hostMessageId: "dot-2" });
    expect(r.success).toBe(true);
    await c.settled(m);
    await sleep(150);
    const frames = c.frames.slice(m);

    expect(frames.filter((f) => f.type === "agent_start")).toHaveLength(2);
    expect(frames.filter((f) => f.type === "session_settled")).toHaveLength(1);
    const first = must(frames.find((f) => f.type === "message_end" && f.message?.role === "assistant"), "interrupted assistant");
    expect(first.message.stopReason).toBe("aborted");
    const pr = must(frames.find((f) => f.type === "prompt_result" && f.id === p1), "prompt_result of the interrupted prompt");
    expect(pr.status).toBe("aborted");
    expect(pr.sessionSettled).toBe(false);
    // answered once the continuation has yielded
    expect(idxOf(frames, "response", idxOf(frames, "agent_start") + 1)).toBeGreaterThan(lastIdx(frames, "agent_end") - 1);

    const list = await entriesOf(c);
    const marker = list.findIndex((e) => e.type === "custom" && e.customType === "host-resume");
    const aborted = list.findIndex((e) => e.type === "message" && e.message?.role === "assistant" && e.message.stopReason === "aborted");
    expect(marker).toBeGreaterThan(-1);
    expect(aborted).toBeGreaterThan(marker); // journaled before the interrupt takes effect
    expect(list.filter((e) => e.type === "message" && e.message?.role === "user")).toHaveLength(1);
  });

  test("an interrupt before any output re-runs the prompt as it was: no directive, answered once the run has started", async () => {
    const c = await rig.spawn();
    rig.setScript({ turns: [hang] });
    let m = c.mark();
    c.fire({ type: "prompt", message: "HANGRUN go" });
    await c.waitType("agent_start", { from: m });
    await sleep(300);
    await c.send({ type: "abort" });
    await c.settled(m);
    const users = await userCount(c);

    m = c.mark();
    const r = await c.send({ type: "resume", hostMessageId: "dot-3" });
    expect(r.success).toBe(true);
    await sleep(500);
    const frames = c.frames.slice(m);
    expect(frames.filter((f) => f.type === "agent_start")).toHaveLength(1);
    expect(idxOf(frames, "response")).toBeGreaterThan(idxOf(frames, "agent_start"));
    expect(frames.filter((f) => f.type === "agent_end")).toHaveLength(0); // still running (the prompt hangs again)
    expect(frames.some((f) => f.type === "message_start" && f.message?.role === "developer")).toBe(false);
    expect(await userCount(c)).toBe(users);
    expect((await markers(c))[0]).toMatchObject({ data: { hostMessageId: "dot-3", text: "." } });
    await c.send({ type: "abort" });
  });

  test("an empty session has nothing to resume, and the marker stays", async () => {
    const c = await rig.spawn();
    const r = await c.send({ type: "resume", hostMessageId: "dot-4" });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("Nothing to resume");
    expect(await markers(c)).toHaveLength(1);
  });

  test("malformed arguments and unknown subagents are refused", async () => {
    const c = await rig.spawn();
    const empty = await c.send({ type: "resume", hostMessageId: "" });
    expect(empty.success).toBe(false);
    expect(String(empty.error)).toContain("hostMessageId must be a non-empty string");
    const sub = await c.send({ type: "resume", subagentId: "" });
    expect(sub.success).toBe(false);
    expect(String(sub.error)).toContain("`subagentId` must be a non-empty string.");
    const ghost = await c.send({ type: "resume", subagentId: "Ghost" });
    expect(ghost.success).toBe(false);
    expect(String(ghost.error)).toContain("Ghost");
    expect(await markers(c)).toEqual([]);
  });
});

describe(`P5 resume on a subagent (${rig.kind})`, () => {
  const script = {
    turns: [
      { when: "SPAWNHANG", steps: [{ text: "delegating" }, { tool: "task", args: { name: "Sleeper", task: "SUBHANG wait forever", solutionSpace: "wait" }, subagent: { steps: [{ text: "waiting" }, { hang: true }] } } as any, { text: "spawned" }] },
      { when: "SUBHANG", steps: [{ text: "waiting" }, { hang: true }] },
    ],
  };
  const subMarkers = (file: string) => readTranscript(file).filter((l) => l.type === "custom" && l.customType === "host-resume");

  test("a running subagent is interrupted and continued; the marker lands in its own transcript; a finished one is revived", async () => {
    const c = await rig.spawn();
    await c.send({ type: "set_subagent_subscription", level: "events" });
    rig.setScript(script);
    const m = c.mark();
    c.fire({ type: "prompt", message: "SPAWNHANG" });
    await c.waitFor((f) => f.type === "subagent_event" && f.payload.event.type === "message_update", { from: m, timeoutMs: 60_000 });
    const listed = (await c.ok<{ subagents: Frame[] }>({ type: "get_subagents" })).subagents;
    const sessionFile = String(must(listed.find((s) => s.id === "Sleeper"), "Sleeper").sessionFile);

    const r = await c.send({ type: "resume", subagentId: "Sleeper", hostMessageId: "sub-dot-1" });
    expect(r.success).toBe(true);
    await c.waitFor((f) => f.type === "subagent_lifecycle" && f.payload.status === "completed", { from: m, timeoutMs: 60_000 });
    await c.settled(m, 60_000);
    expect(subMarkers(sessionFile)).toHaveLength(1);
    expect(subMarkers(sessionFile)[0]).toMatchObject({ data: { hostMessageId: "sub-dot-1", text: "." } });
    // the interrupted turn is journaled as aborted, then the directive and its answer follow
    const roles = readTranscript(sessionFile).filter((l) => l.type === "message").map((l) => `${l.message.role}${l.message.stopReason === "aborted" ? "/aborted" : ""}`);
    expect(roles).toEqual(["user", "assistant/aborted", "developer", "assistant"]);
    // the parent session carries no marker of its own for it
    expect((await entriesOf(c)).some((e) => e.type === "custom" && e.customType === "host-resume")).toBe(false);

    // finished, but still registered: resume revives it (lifecycle started again), then it completes and wakes the parent
    expect((await c.ok<{ subagents: Frame[] }>({ type: "get_subagents" })).subagents).toEqual([]);
    const m2 = c.mark();
    const again = await c.send({ type: "resume", subagentId: "Sleeper", hostMessageId: "sub-dot-2" });
    expect(again.success).toBe(true);
    await c.waitFor((f) => f.type === "subagent_lifecycle" && f.payload.status === "completed", { from: m2, timeoutMs: 60_000 });
    await c.settled(m2, 60_000);
    const life = c.frames.slice(m2).filter((f) => f.type === "subagent_lifecycle").map((f) => f.payload.status);
    expect(life).toEqual(["started", "completed"]);
    expect(subMarkers(sessionFile).map((l) => l.data.hostMessageId)).toEqual(["sub-dot-1", "sub-dot-2"]);
    expect(c.frames.slice(m2).some((f) => f.type === "agent_start")).toBe(true); // the parent wakes with the result
  });
});
