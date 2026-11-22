// R3 navigate_tree (revert/redo), R4 fork/branch and R5 directory move, on hand-written fixture transcripts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { must, Rig, readTranscript, sleep, tree, writeFixture, type OmpChild } from "./harness";

setDefaultTimeout(90_000);

const rig = new Rig();
afterAll(() => rig.close());

const texts = (messages: any[]) => messages.map((m) => `${m.role}:${m.content?.[0]?.text ?? ""}`);

async function open(): Promise<{ c: OmpChild; fx: ReturnType<typeof writeFixture> }> {
  const fx = writeFixture(rig);
  const c = await rig.spawn();
  expect((await c.send({ type: "switch_session", sessionPath: fx.path })).success).toBe(true);
  return { c, fx };
}

describe(`R3 navigate_tree (${rig.kind})`, () => {
  test("revert to a user message and redo: the leaf moves in memory, the file is untouched", async () => {
    const { c, fx } = await open();
    const before = readFileSync(fx.path, "utf8");

    // revert to message u2: its parent becomes the leaf, the text goes back to the editor
    const nav = await c.send({ type: "navigate_tree", entryId: fx.ids.u2 });
    expect(nav.success).toBe(true);
    expect(nav.data.cancelled).toBe(false);
    expect(nav.data.editorText).toBe("question 2");
    expect(texts((await c.send({ type: "get_messages" })).data.messages)).toEqual(["user:question 1", "assistant:answer 1"]);
    const entries = (await c.send({ type: "get_entries" })).data;
    expect(entries.leafId).toBe(fx.ids.a1);
    expect(entries.entries).toHaveLength(6); // the abandoned branch is still in the list
    expect(readFileSync(fx.path, "utf8")).toBe(before);

    // a second process opening the file now still sees the old leaf: the revert is not durable yet
    const other = await rig.spawn();
    await other.send({ type: "switch_session", sessionPath: fx.path });
    expect((await other.send({ type: "get_entries" })).data.leafId).toBe(fx.ids.a3);

    // redo: navigate back to the abandoned leaf
    const redo = await c.send({ type: "navigate_tree", entryId: fx.ids.a3 });
    expect(redo.success).toBe(true);
    expect(redo.data.cancelled).toBe(false);
    expect(redo.data.editorText).toBeUndefined();
    expect(texts((await c.send({ type: "get_messages" })).data.messages)).toHaveLength(6);
    expect((await c.send({ type: "get_entries" })).data.leafId).toBe(fx.ids.a3);
    expect(readFileSync(fx.path, "utf8")).toBe(before);
  });

  test("navigating to an assistant message keeps it as the leaf, with no editor text", async () => {
    const { c, fx } = await open();
    const nav = await c.send({ type: "navigate_tree", entryId: fx.ids.a1 });
    expect(nav.success).toBe(true);
    expect(nav.data.editorText).toBeUndefined();
    expect((await c.send({ type: "get_entries" })).data.leafId).toBe(fx.ids.a1);
  });

  test("the next prompt after a revert becomes a new branch off the revert point, durably", async () => {
    const { c, fx } = await open();
    await c.send({ type: "navigate_tree", entryId: fx.ids.u2 });
    rig.setScript({ turns: [] });
    const m = c.mark();
    await c.send({ type: "prompt", message: "branch prompt" });
    await c.settled(m);
    await sleep(100);
    const { entries } = tree(fx.path);
    // the abandoned branch is still in the file, the new user entry hangs off a1
    expect(entries.slice(0, 6).map((e) => e.id)).toEqual([fx.ids.u1, fx.ids.a1, fx.ids.u2, fx.ids.a2, fx.ids.u3, fx.ids.a3]);
    const newUser = entries.slice(6).find((e) => e.type === "message" && e.message.role === "user");
    // omp may journal bookkeeping entries (reminders, digests) between a1 and the user message; the chain must still pass a1, never u2
    const byId = new Map(entries.map((e) => [e.id, e]));
    const chain: string[] = [];
    for (let e = newUser; e; e = e.parentId ? byId.get(e.parentId) : undefined) chain.push(e.id);
    expect(chain).toContain(fx.ids.a1);
    expect(chain).not.toContain(fx.ids.u2);
    expect(texts((await c.send({ type: "get_messages" })).data.messages).slice(0, 3)).toEqual(["user:question 1", "assistant:answer 1", expect.stringContaining("branch prompt")]);
    // a fresh process loading the file sees the active branch only
    const other = await rig.spawn();
    await other.send({ type: "switch_session", sessionPath: fx.path });
    const msgs = texts((await other.send({ type: "get_messages" })).data.messages);
    expect(msgs).toHaveLength(4);
    expect(msgs.some((t) => t.includes("question 3"))).toBe(false);
    // redo of the abandoned branch is still possible through the tree
    expect((await c.send({ type: "navigate_tree", entryId: fx.ids.a3 })).success).toBe(true);
    expect(texts((await c.send({ type: "get_messages" })).data.messages)).toHaveLength(6);
  });

  test("errors: unknown entry, and a busy session", async () => {
    const { c, fx } = await open();
    const missing = await c.send({ type: "navigate_tree", entryId: "zzzz" });
    expect(missing.success).toBe(false);
    expect(missing.code).toBe("entry_not_found");

    rig.setScript({ turns: [{ when: "HANGRUN", steps: [{ text: "start" }, { hang: true }] }] });
    const m = c.mark();
    c.fire({ type: "prompt", message: "HANGRUN" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    const busy = await c.send({ type: "navigate_tree", entryId: fx.ids.a1 });
    expect(busy.success).toBe(false);
    expect(busy.code).toBe("session_busy");
    await c.send({ type: "abort" });
    await c.settled(m);
  });
});

describe(`R4 fork and branch (${rig.kind})`, () => {
  test("fork at an entry writes a new transcript with the path to it, lineage and preserved ids", async () => {
    const { c, fx } = await open();
    const before = readFileSync(fx.path, "utf8");
    const forked = await c.send({ type: "fork", entryId: fx.ids.a2 });
    expect(forked.success).toBe(true);
    expect(forked.data.cancelled).toBe(false);

    const state = (await c.send({ type: "get_state" })).data;
    expect(state.sessionFile).not.toBe(fx.path);
    expect(state.sessionId).not.toBe(fx.id);
    expect(existsSync(state.sessionFile)).toBe(true);
    expect(state.sessionFile.startsWith(fx.path.slice(0, fx.path.lastIndexOf("/")))).toBe(true); // same bucket

    const lines = readFileSync(state.sessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("title"); // 256-byte title slot first
    const { header, entries } = tree(state.sessionFile);
    expect(header.type).toBe("session");
    expect(header.id).toBe(state.sessionId);
    expect(header.cwd).toBe(rig.project);
    expect(header.parentSession).toBe(fx.path); // lineage is the parent's file path, not its id
    expect(entries.map((e) => e.id)).toEqual([fx.ids.u1, fx.ids.a1, fx.ids.u2, fx.ids.a2]);
    expect(entries.map((e) => e.parentId)).toEqual([null, fx.ids.u1, fx.ids.a1, fx.ids.u2]);
    expect(texts((await c.send({ type: "get_messages" })).data.messages)).toEqual(["user:question 1", "assistant:answer 1", "user:question 2", "assistant:answer 2"]);
    expect(readFileSync(fx.path, "utf8")).toBe(before);
    expect((await c.send({ type: "get_entries" })).data.leafId).toBe(fx.ids.a2);
  });

  test("branch from a user message keeps what came before it and returns its text", async () => {
    const { c, fx } = await open();
    const r = await c.send({ type: "branch", entryId: fx.ids.u2 });
    expect(r.success).toBe(true);
    expect(r.data.cancelled).toBe(false);
    expect(r.data.text).toBe("question 2");
    const state = (await c.send({ type: "get_state" })).data;
    expect(state.sessionFile).not.toBe(fx.path);
    const { header, entries } = tree(state.sessionFile);
    expect(header.parentSession).toBe(fx.path);
    expect(entries.map((e) => e.id)).toEqual([fx.ids.u1, fx.ids.a1]);
  });

  test("fork is refused while a run is live", async () => {
    const { c, fx } = await open();
    rig.setScript({ turns: [{ when: "HANGRUN", steps: [{ text: "start" }, { hang: true }] }] });
    const m = c.mark();
    c.fire({ type: "prompt", message: "HANGRUN" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    const r = await c.send({ type: "fork", entryId: fx.ids.a2 });
    expect(r.success).toBe(false);
    expect(r.code).toBe("session_busy");
    await c.send({ type: "abort" });
    await c.settled(m);
  });

  test("new_session creates a header-only transcript and takes the lease at once", async () => {
    const { c } = await open();
    const r = await c.send({ type: "new_session" });
    expect(r.success).toBe(true);
    expect(r.data.cancelled).toBe(false);
    const state = (await c.send({ type: "get_state" })).data;
    expect(state.messageCount).toBe(0);
    // unlike a fresh process, new_session forces the (header-only) file into existence and takes the lease
    expect(existsSync(state.sessionFile)).toBe(true);
    const lines = readTranscript(state.sessionFile);
    // header only: omp may add bookkeeping entries (thinking_level_change, service_tier_change) but no messages
    expect(lines.slice(0, 2).map((l) => l.type)).toEqual(["title", "session"]);
    expect(lines.some((l) => l.type === "message")).toBe(false);
    const probe = await rig.spawn();
    expect((await probe.send({ type: "get_session_lease", sessionIds: [state.sessionId] })).data.held).toEqual([state.sessionId]);
  });
});

describe(`R5 directory move without a driven prompt (${rig.kind})`, () => {
  test("`/move <dir>` on a utility child that only opened the session relocates it: no model, same id, header cwd rewritten", async () => {
    const dest = join(rig.home, "other");
    mkdirSync(dest, { recursive: true });
    const { c, fx } = await open();
    const m = c.mark();
    const modelCalls = rig.fake.requests.length;
    const r = await c.send({ type: "prompt", message: `/move ${dest}` });
    expect(r.success).toBe(true);
    expect(r.data.agentInvoked).toBe(false);
    const frames = c.frames.slice(m);
    const out = must(frames.find((f) => f.type === "command_output"), "command_output frame");
    expect(out.text).toBe(`Moved to ${dest}.`);
    expect(frames.findIndex((f) => f.type === "command_output")).toBeLessThan(frames.findIndex((f) => f.type === "response"));
    expect(frames.some((f) => f.type === "agent_start" || f.type === "prompt_result")).toBe(false);
    const state = (await c.send({ type: "get_state" })).data;
    expect(state.sessionId).toBe(fx.id);
    expect(state.sessionFile).not.toBe(fx.path);
    expect(state.sessionFile).toContain("-other");
    expect(existsSync(fx.path)).toBe(false);
    const { header, entries } = tree(state.sessionFile);
    expect(header.cwd).toBe(dest);
    expect(header.id).toBe(fx.id);
    expect(header.previousSessionFiles).toEqual([fx.path]);
    expect(entries.map((e) => e.id)).toEqual([fx.ids.u1, fx.ids.a1, fx.ids.u2, fx.ids.a2, fx.ids.u3, fx.ids.a3]);
    expect(rig.fake.requests.length).toBe(modelCalls);
  });

  test("the move is refused, and nothing is touched, while another live process writes the session", async () => {
    const dest = join(rig.home, "elsewhere");
    mkdirSync(dest, { recursive: true });
    const fx = writeFixture(rig);
    const holder = await rig.spawn();
    await holder.send({ type: "switch_session", sessionPath: fx.path });
    rig.setScript({ turns: [] });
    const hm = holder.mark();
    await holder.send({ type: "prompt", message: "write" });
    await holder.settled(hm);
    const util = await rig.spawn();
    await util.send({ type: "switch_session", sessionPath: fx.path });
    const m = util.mark();
    const r = await util.send({ type: "prompt", message: `/move ${dest}` });
    expect(r.success).toBe(true);
    const out = must(util.frames.slice(m).find((f) => f.type === "command_output"), "command_output frame");
    expect(out.text).toContain("another live omp process writes it. Nothing was moved.");
    expect(existsSync(fx.path)).toBe(true);
    expect(readFileSync(fx.path, "utf8")).toContain(`"cwd":"${rig.project}"`);
  });

  test("a missing target directory is reported, not created", async () => {
    const { c, fx } = await open();
    const m = c.mark();
    await c.send({ type: "prompt", message: `/move ${join(rig.home, "does-not-exist")}` });
    expect(must(c.frames.slice(m).find((f) => f.type === "command_output"), "command_output frame").text).toContain("Directory does not exist");
    expect(existsSync(fx.path)).toBe(true);
  });
});
