// P1: `hostMessageId` on prompt / steer / follow_up / abort_and_prompt is stored on the journaled user message
// (`message.hostMessageId`) and echoed on that message's message_start / message_end. Runs against the stub and the real omp.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { must, readTranscript, Rig, sleep, type Frame, type OmpChild } from "./harness";

setDefaultTimeout(90_000);

const rig = new Rig();
let c: OmpChild;
beforeAll(async () => { c = await rig.spawn(); });
afterAll(() => rig.close());

const textOf = (message: Frame) => String(message.content?.[0]?.text ?? "");
/** user text → hostMessageId (or undefined) from message_start frames since `from`. */
const startIds = (from: number) => Object.fromEntries(
  c.frames.slice(from).filter((f) => f.type === "message_start" && f.message?.role === "user").map((f) => [textOf(f.message), f.message.hostMessageId]),
);
const endIds = (from: number) => Object.fromEntries(
  c.frames.slice(from).filter((f) => f.type === "message_end" && f.message?.role === "user").map((f) => [textOf(f.message), f.message.hostMessageId]),
);
async function journalIds(child: OmpChild = c) {
  const { entries } = await child.ok<{ entries: Frame[] }>({ type: "get_entries" });
  return Object.fromEntries(entries.filter((e) => e.type === "message" && e.message?.role === "user").map((e) => [textOf(e.message), e.message.hostMessageId]));
}
const slow = { when: "SLOWRUN", steps: [{ text: "working" }, { sleep: 700 }, { text: " more" }] };

describe(`P1 hostMessageId (${rig.kind})`, () => {
  test("prompt: the id is on the message_start/message_end frames and on the journaled entry, nowhere else", async () => {
    rig.setScript({ turns: [] });
    const m = c.mark();
    await c.send({ type: "prompt", message: "hello", hostMessageId: "host-1" });
    await c.settled(m);
    expect(startIds(m)).toEqual({ hello: "host-1" });
    expect(endIds(m)).toEqual({ hello: "host-1" });
    expect((await journalIds()).hello).toBe("host-1");
    const entries = (await c.ok<{ entries: Frame[] }>({ type: "get_entries" })).entries;
    const assistant = must(entries.filter((e) => e.message?.role === "assistant").at(-1), "assistant entry");
    expect(assistant.message.hostMessageId).toBeUndefined();
    // on disk too
    const file = (await c.ok({ type: "get_state" })).sessionFile as string;
    const onDisk = readTranscript(file).find((l) => l.type === "message" && textOf(l.message) === "hello");
    expect(must(onDisk, "journaled user line").message.hostMessageId).toBe("host-1");
  });

  test("a prompt without an id carries none", async () => {
    rig.setScript({ turns: [] });
    const m = c.mark();
    await c.send({ type: "prompt", message: "plain" });
    await c.settled(m);
    expect(startIds(m)).toEqual({ plain: undefined });
    expect((await journalIds()).plain).toBeUndefined();
  });

  test("steer and follow_up sent mid-run keep their ids, in delivery order", async () => {
    rig.setScript({ turns: [slow] });
    const m = c.mark();
    c.fire({ type: "prompt", message: "SLOWRUN a", hostMessageId: "host-prompt" });
    await c.waitType("agent_start", { from: m });
    await c.send({ type: "follow_up", message: "follow c", hostMessageId: "host-follow" });
    await c.send({ type: "steer", message: "steer b", hostMessageId: "host-steer" });
    await c.settled(m);
    await sleep(100);
    expect(startIds(m)).toEqual({ "SLOWRUN a": "host-prompt", "steer b": "host-steer", "follow c": "host-follow" });
    expect(endIds(m)).toEqual(startIds(m));
    const journal = await journalIds();
    expect(journal["SLOWRUN a"]).toBe("host-prompt");
    expect(journal["steer b"]).toBe("host-steer");
    expect(journal["follow c"]).toBe("host-follow");
    // the steer is delivered first and still flagged as one
    const steer = must(c.frames.slice(m).find((f) => f.type === "message_start" && textOf(f.message ?? {}) === "steer b"), "steer message_start");
    expect(steer.message.steering).toBe(true);
  });

  test("get_queued_prompts lists the queue with its host ids, takes nothing out, and abort_and_restore_queue returns the same ids", async () => {
    rig.setScript({ turns: [slow] });
    const m = c.mark();
    c.fire({ type: "prompt", message: "SLOWRUN lp", hostMessageId: "host-lp0" });
    await c.waitType("agent_start", { from: m });
    await c.send({ type: "follow_up", message: "follow lp", hostMessageId: "host-lp-follow" });
    await c.send({ type: "steer", message: "steer lp", hostMessageId: "host-lp-steer" });
    const listed = (await c.send({ type: "get_queued_prompts" })).data;
    const pick = (queue: any[]) => queue.map((entry) => [entry.text, entry.hostMessageId]);
    expect(pick(listed.followUp)).toEqual([["follow lp", "host-lp-follow"]]);
    expect(pick(listed.steering)).toContainEqual(["steer lp", "host-lp-steer"]);
    // listing again finds the same queue: nothing was taken out
    expect(pick((await c.send({ type: "get_queued_prompts" })).data.followUp)).toEqual([["follow lp", "host-lp-follow"]]);
    const restored = (await c.send({ type: "abort_and_restore_queue" })).data;
    expect(pick(restored.followUp)).toEqual([["follow lp", "host-lp-follow"]]);
    expect(pick(restored.steering)).toContainEqual(["steer lp", "host-lp-steer"]);
    await c.settled(m);
    const after = (await c.send({ type: "get_queued_prompts" })).data;
    expect([...after.steering, ...after.followUp]).toEqual([]);
  });

  test("prompt{streamingBehavior} queued mid-run keeps its id", async () => {
    rig.setScript({ turns: [slow] });
    const m = c.mark();
    c.fire({ type: "prompt", message: "SLOWRUN q", hostMessageId: "host-q1" });
    await c.waitType("agent_start", { from: m });
    await c.send({ type: "prompt", message: "queued q2", streamingBehavior: "followUp", hostMessageId: "host-q2" });
    await c.settled(m);
    await sleep(100);
    expect(startIds(m)).toEqual({ "SLOWRUN q": "host-q1", "queued q2": "host-q2" });
  });

  test("steer and follow_up on an idle session start a run and carry their ids", async () => {
    rig.setScript({ turns: [] });
    let m = c.mark();
    await c.send({ type: "steer", message: "idle steer", hostMessageId: "host-is" });
    await c.settled(m);
    expect(startIds(m)).toEqual({ "idle steer": "host-is" });
    m = c.mark();
    await c.send({ type: "follow_up", message: "idle follow", hostMessageId: "host-if" });
    await c.settled(m);
    expect(startIds(m)).toEqual({ "idle follow": "host-if" });
  });

  test("abort_and_prompt: the replacement message carries the id", async () => {
    rig.setScript({ turns: [slow] });
    const m = c.mark();
    c.fire({ type: "prompt", message: "SLOWRUN z", hostMessageId: "host-z" });
    await c.waitType("agent_start", { from: m });
    await c.send({ type: "abort_and_prompt", message: "replacement", hostMessageId: "host-repl" });
    await c.settled(m);
    await sleep(100);
    expect(startIds(m)).toEqual({ "SLOWRUN z": "host-z", replacement: "host-repl" });
    expect((await journalIds()).replacement).toBe("host-repl");
  });

  test("an empty or non-string id is refused before anything runs", async () => {
    for (const type of ["prompt", "steer", "follow_up", "abort_and_prompt"] as const) {
      for (const hostMessageId of ["", 3]) {
        const m = c.mark();
        const r = await c.send({ type, message: "never runs", hostMessageId });
        expect(r.success).toBe(false);
        expect(String(r.error)).toContain("hostMessageId must be a non-empty string");
        await sleep(50);
        expect(c.shape(m)).toEqual([`response:${type}!`]);
      }
    }
    expect((await journalIds())["never runs"]).toBeUndefined();
  });

  test("the id survives a reload and a fork, and is never sent to the model", async () => {
    const solo = await rig.spawn();
    rig.setScript({ turns: [] });
    const m = solo.mark();
    await solo.send({ type: "prompt", message: "keep my id", hostMessageId: "host-keep" });
    await solo.settled(m);
    const state = await solo.ok({ type: "get_state" });
    const entries = (await solo.ok<{ entries: Frame[] }>({ type: "get_entries" })).entries;
    const lastAssistant = must(entries.filter((e) => e.message?.role === "assistant").at(-1), "assistant entry");

    // reload: a second process opens the transcript
    const reader = await rig.spawn();
    await reader.send({ type: "switch_session", sessionPath: state.sessionFile });
    expect((await journalIds(reader))["keep my id"]).toBe("host-keep");
    const messages = (await reader.ok<{ messages: Frame[] }>({ type: "get_messages" })).messages;
    expect(must(messages.find((x) => x.role === "user"), "user message").hostMessageId).toBe("host-keep");

    // fork: the copy keeps the id on the copied entry
    await solo.send({ type: "fork", entryId: lastAssistant.id });
    expect((await journalIds(solo))["keep my id"]).toBe("host-keep");

    if (rig.kind === "real") {
      const sent = JSON.stringify(rig.fake.requests);
      expect(sent).toContain("keep my id");
      expect(sent).not.toContain("host-keep");
      expect(sent).not.toContain("hostMessageId");
    }
  });
});
