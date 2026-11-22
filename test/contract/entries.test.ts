// R2: get_entries{since}, user-entry order under steer/follow-up, compaction, and when a transcript file comes to exist.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync } from "node:fs";
import { must, Rig, readTranscript, sleep, writeFixture, type OmpChild } from "./harness";

setDefaultTimeout(90_000);

const rig = new Rig();
let c: OmpChild;
beforeAll(async () => { c = await rig.spawn(); });
afterAll(() => rig.close());

const userText = (e: any) => String(e.message?.content?.[0]?.text ?? "");
const users = (entries: any[]) => entries.filter((e) => e.type === "message" && e.message?.role === "user");

describe(`R2 get_entries (${rig.kind})`, () => {
  test("with and without since on a fixture transcript", async () => {
    const fx = writeFixture(rig);
    const child = await rig.spawn();
    expect((await child.send({ type: "switch_session", sessionPath: fx.path })).success).toBe(true);
    const all = (await child.send({ type: "get_entries" })).data;
    expect(all.entries.map((e: any) => e.id)).toEqual([fx.ids.u1, fx.ids.a1, fx.ids.u2, fx.ids.a2, fx.ids.u3, fx.ids.a3]);
    expect(all.leafId).toBe(fx.ids.a3);
    const since = (await child.send({ type: "get_entries", since: fx.ids.u2 })).data;
    expect(since.entries.map((e: any) => e.id)).toEqual([fx.ids.a2, fx.ids.u3, fx.ids.a3]);
    expect(since.leafId).toBe(fx.ids.a3);
    const tail = (await child.send({ type: "get_entries", since: fx.ids.a3 })).data;
    expect(tail.entries).toEqual([]);
    const unknown = await child.send({ type: "get_entries", since: "nope" });
    expect(unknown.success).toBe(false);
    expect(unknown.code).toBe("unknown_since");
  });

  test("a cursor from another session is unknown_since (the only way a cursor goes stale)", async () => {
    const a = writeFixture(rig);
    const b = writeFixture(rig);
    const child = await rig.spawn();
    await child.send({ type: "switch_session", sessionPath: b.path });
    const r = await child.send({ type: "get_entries", since: a.ids.u2 });
    expect(r.success).toBe(false);
    expect(r.code).toBe("unknown_since");
  });

  test("user entries are appended in delivery order, not acceptance order: a steer overtakes an earlier follow-up", async () => {
    rig.setScript({ turns: [{ when: "SLOWRUN", steps: [{ text: "working" }, { sleep: 700 }, { text: " more" }] }] });
    // prime so there is a cursor
    const prime = c.mark();
    await c.send({ type: "prompt", message: "prime" });
    await c.settled(prime);
    const cursor = (await c.send({ type: "get_entries" })).data.leafId as string;
    expect(typeof cursor).toBe("string");

    const m = c.mark();
    c.fire({ type: "prompt", message: "SLOWRUN start" });
    await c.waitFor((f) => f.type === "message_update", { from: m });
    expect((await c.send({ type: "follow_up", message: "FOLLOWUP accepted first" })).success).toBe(true);
    expect((await c.send({ type: "steer", message: "STEER accepted second" })).success).toBe(true);
    await c.settled(m);

    const delta = (await c.send({ type: "get_entries", since: cursor })).data;
    const fromEntries = users(delta.entries).map(userText);
    const kind = (t: string) => (t.includes("SLOWRUN") ? "start" : t.includes("STEER") ? "steer" : t.includes("FOLLOWUP") ? "followup" : t);
    expect(fromEntries.map(kind)).toEqual(["start", "steer", "followup"]);
    // the live message_start frames and the journal agree
    const fromFrames = c.frames.slice(m).filter((f) => f.type === "message_start" && f.message?.role === "user").map((f) => String(f.message.content?.[0]?.text));
    expect(fromFrames.map(kind)).toEqual(["start", "steer", "followup"]);
    // since-cursor entries are exactly the entries after the cursor in the full list
    const everything = (await c.send({ type: "get_entries" })).data.entries as any[];
    const idx = everything.findIndex((e) => e.id === cursor);
    expect(delta.entries.map((e: any) => e.id)).toEqual(everything.slice(idx + 1).map((e) => e.id));
  });

  test("compaction is append-only: older cursors stay valid and the compaction entry is a new tail entry", async () => {
    const fx = writeFixture(rig, rig.project, "-proj", 60_000);
    const child = await rig.spawn();
    await child.send({ type: "switch_session", sessionPath: fx.path });
    rig.setScript({ turns: [{ steps: [{ text: "SUMMARY text here" }] }] });
    const m = child.mark();
    const r = await child.send({ type: "compact" }, 60_000);
    expect(r.success).toBe(true);
    expect(typeof r.data.firstKeptEntryId).toBe("string");
    expect(typeof r.data.summary).toBe("string");
    const types = child.frames.slice(m).map((f) => f.type);
    expect(types.indexOf("manual_compaction_start")).toBeGreaterThan(-1);
    const end = must(child.frames.slice(m).find((f) => f.type === "manual_compaction_end"), "manual_compaction_end frame");
    expect(end.aborted).toBe(false);
    const since = (await child.send({ type: "get_entries", since: fx.ids.u2 })).data;
    expect(since.entries.at(-1).type).toBe("compaction");
    expect(since.leafId).toBe(since.entries.at(-1).id);
    // append-only: the fixture lines are all still in the file
    const onDisk = readTranscript(fx.path).filter((l) => l.type === "message").map((l) => l.id);
    expect(onDisk).toEqual([fx.ids.u1, fx.ids.a1, fx.ids.u2, fx.ids.a2, fx.ids.u3, fx.ids.a3]);
  });

  test("compacting a session that is too small is refused with manual_compaction_end{skipped}", async () => {
    const fx = writeFixture(rig);
    const child = await rig.spawn();
    await child.send({ type: "switch_session", sessionPath: fx.path });
    const m = child.mark();
    const r = await child.send({ type: "compact" }, 60_000);
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("Nothing to compact");
    const end = must(child.frames.slice(m).find((f) => f.type === "manual_compaction_end"), "manual_compaction_end frame");
    expect(end.skipped).toBe(true);
  });

  test("a session has no transcript file, and no lease, until its first assistant message; model/effort are journaled", async () => {
    const child = await rig.spawn();
    const state = (await child.send({ type: "get_state" })).data;
    expect(typeof state.sessionFile).toBe("string");
    expect(existsSync(state.sessionFile)).toBe(false);
    expect((await child.send({ type: "set_model", provider: "fake", modelId: "smart" })).success).toBe(true);
    expect((await child.send({ type: "set_thinking_level", level: "high" })).success).toBe(true);
    expect(existsSync(state.sessionFile)).toBe(false);
    const probe = (await c.send({ type: "get_session_lease", sessionIds: [state.sessionId] })).data;
    expect(probe.held).toEqual([]);

    rig.setScript({ turns: [] });
    const m = child.mark();
    await child.send({ type: "prompt", message: "journal please" });
    await child.settled(m);
    await sleep(100);
    expect(existsSync(state.sessionFile)).toBe(true);
    const lines = readTranscript(state.sessionFile);
    const modelChange = must(lines.filter((l) => l.type === "model_change").at(-1), "model_change entry");
    expect(modelChange.model).toBe("fake/smart");
    expect(modelChange.role).toBe("default");
    expect(modelChange.resolvedModelIsFallback).toBe(false);
    const thinking = must(lines.filter((l) => l.type === "thinking_level_change").at(-1), "thinking_level_change entry");
    expect(thinking.thinkingLevel).toBe("high");
    expect(thinking.configured).toBe("high");
    // every journal entry has id/parentId and the assistant message names the model that ran
    for (const l of lines.filter((x) => x.type !== "session" && x.type !== "title")) expect(typeof l.id).toBe("string");
    const assistant = must(lines.find((l) => l.type === "message" && l.message.role === "assistant"), "assistant entry");
    expect(`${assistant.message.provider}/${assistant.message.model}`).toBe("fake/smart");
    const lease = (await c.send({ type: "get_session_lease", sessionIds: [state.sessionId] })).data;
    expect(lease.held).toEqual([state.sessionId]);
  });
});

describe(`sidecar records rule (${rig.kind})`, () => {
  test("a line without an id appended to omp's transcript leaves the leaf undefined and the history empty", async () => {
    const fx = writeFixture(rig);
    appendFileSync(fx.path, `${JSON.stringify({ type: "oc_notice", text: "foreign" })}\n`);
    const child = await rig.spawn();
    expect((await child.send({ type: "switch_session", sessionPath: fx.path })).success).toBe(true);
    const entries = (await child.send({ type: "get_entries" })).data;
    expect(entries.leafId).toBeUndefined();
    expect(entries.entries.at(-1).type).toBe("oc_notice");
    expect((await child.send({ type: "get_messages" })).data.messages).toHaveLength(0);
    expect((await child.send({ type: "get_state" })).data.messageCount).toBe(0);
  });

  test("a foreign record that does carry id/parentId extends the branch and keeps the history", async () => {
    const fx = writeFixture(rig);
    appendFileSync(fx.path, `${JSON.stringify({ type: "oc_marker", id: "ffff0000", parentId: fx.ids.a3, timestamp: new Date().toISOString() })}\n`);
    const child = await rig.spawn();
    await child.send({ type: "switch_session", sessionPath: fx.path });
    expect((await child.send({ type: "get_entries" })).data.leafId).toBe("ffff0000");
    expect((await child.send({ type: "get_messages" })).data.messages).toHaveLength(6);
  });
});
