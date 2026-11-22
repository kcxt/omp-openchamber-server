// P2: `append_custom_entry {customType, data?}` → `{entryId}`: a `custom` entry journaled through the session manager
// with a proper id/parentId on the current branch, never sent to the model. Runs against the stub and the real omp.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { must, readTranscript, Rig, tree, writeFixture, type Frame, type OmpChild } from "./harness";

setDefaultTimeout(90_000);

const rig = new Rig();
let c: OmpChild;
beforeAll(async () => { c = await rig.spawn(); });
afterAll(() => rig.close());

const entriesOf = async (child: OmpChild = c) => (await child.ok<{ entries: Frame[]; leafId?: string }>({ type: "get_entries" }));

describe(`P2 append_custom_entry (${rig.kind})`, () => {
  test("journals a custom entry chained onto the leaf, in memory and on disk", async () => {
    rig.setScript({ turns: [] });
    const m = c.mark();
    await c.send({ type: "prompt", message: "hello" });
    await c.settled(m);
    const before = await entriesOf();

    const r = await c.send({ type: "append_custom_entry", customType: "oc_notice", data: { text: "compacted", n: 2 } });
    expect(r.success).toBe(true);
    const entryId = r.data.entryId as string;
    expect(typeof entryId).toBe("string");

    const after = await entriesOf();
    expect(after.leafId).toBe(entryId);
    const entry = must(after.entries.find((e) => e.id === entryId), "custom entry");
    expect(entry).toMatchObject({ type: "custom", customType: "oc_notice", data: { text: "compacted", n: 2 }, parentId: before.leafId });

    const file = (await c.ok({ type: "get_state" })).sessionFile as string;
    const line = must(readTranscript(file).find((l) => l.id === entryId), "entry on disk");
    expect(line).toMatchObject({ type: "custom", customType: "oc_notice", parentId: before.leafId });
  });

  test("consecutive entries chain, `data` is optional and any JSON value", async () => {
    const a = await c.ok<{ entryId: string }>({ type: "append_custom_entry", customType: "first", data: [1, "two", { three: 3 }] });
    const b = await c.ok<{ entryId: string }>({ type: "append_custom_entry", customType: "second" });
    const list = (await entriesOf()).entries;
    const first = must(list.find((e) => e.id === a.entryId), "first");
    const second = must(list.find((e) => e.id === b.entryId), "second");
    expect(first.data).toEqual([1, "two", { three: 3 }]);
    expect(second.parentId).toBe(a.entryId);
    expect("data" in second).toBe(false);
  });

  test("it is not a message and the model never receives it", async () => {
    await c.ok({ type: "append_custom_entry", customType: "oc_notice", data: { text: "SECRET-NOTICE-TEXT" } });
    const count = (await c.ok<{ messages: Frame[] }>({ type: "get_messages" })).messages.length;
    rig.setScript({ turns: [] });
    const m = c.mark();
    await c.send({ type: "prompt", message: "echo" });
    await c.settled(m);
    expect((await c.ok<{ messages: Frame[] }>({ type: "get_messages" })).messages.length).toBe(count + 2);
    if (rig.kind === "real") {
      const sent = JSON.stringify(rig.fake.requests);
      expect(sent).not.toContain("SECRET-NOTICE-TEXT");
      expect(sent).not.toContain("oc_notice");
    }
  });

  test("a missing or non-string customType is refused", async () => {
    for (const customType of ["", 5, undefined]) {
      const r = await c.send({ type: "append_custom_entry", customType });
      expect(r.success).toBe(false);
      expect(String(r.error)).toContain("customType must be a non-empty string");
    }
  });

  test("on a session that has written nothing the entry waits in memory with the rest", async () => {
    const fresh = await rig.spawn();
    const file = (await fresh.ok({ type: "get_state" })).sessionFile as string;
    const r = await fresh.ok<{ entryId: string }>({ type: "append_custom_entry", customType: "early", data: 1 });
    expect((await entriesOf(fresh)).entries.some((e) => e.id === r.entryId)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  test("after navigate_tree it makes the new leaf durable (host-revert, PLAN §3.9)", async () => {
    const fx = writeFixture(rig);
    const child = await rig.spawn();
    await child.send({ type: "switch_session", sessionPath: fx.path });
    await child.ok({ type: "navigate_tree", entryId: fx.ids.u2 }); // user message: the leaf becomes its parent, a1
    const { entryId } = await child.ok<{ entryId: string }>({ type: "append_custom_entry", customType: "host-revert", data: { messageID: "m2" } });
    const t = tree(fx.path);
    const written = must(t.entries.find((e) => e.id === entryId), "host-revert on disk");
    expect(written.parentId).toBe(fx.ids.a1);
    expect(t.entries.at(-1)!.id).toBe(entryId); // a second process now sees this as the leaf
    expect((await entriesOf(child)).leafId).toBe(entryId);
  });
});
