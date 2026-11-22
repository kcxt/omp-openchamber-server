// P3: `switch_session {claimLease:true}` takes the target's ownership lease on open (before any write) and refuses
// with code `session_busy` when another live process owns it, leaving the current session, run and queue untouched.
// Runs against the stub and the real omp.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { must, readTranscript, Rig, sleep, writeFixture, writeFileSync, type OmpChild } from "./harness";

setDefaultTimeout(90_000);

const rig = new Rig();
afterAll(() => rig.close());

const held = async (util: OmpChild, ...ids: string[]) => (await util.ok<{ held: string[] }>({ type: "get_session_lease", sessionIds: ids })).held;

describe(`P3 switch_session claimLease (${rig.kind})`, () => {
  test("a free session is claimed on open: held before any write, then a later claimer is refused with session_busy", async () => {
    const fx = writeFixture(rig);
    const owner = await rig.spawn();
    const util = await rig.spawn();
    const late = await rig.spawn();
    expect(await held(util, fx.id)).toEqual([]);

    const r = await owner.send({ type: "switch_session", sessionPath: fx.path, claimLease: true });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ cancelled: false });
    expect(await held(util, fx.id)).toEqual([fx.id]); // opened, nothing written, lease already taken

    const before = await late.ok({ type: "get_state" });
    const refused = await late.send({ type: "switch_session", sessionPath: fx.path, claimLease: true });
    expect(refused.success).toBe(false);
    expect(refused.code).toBe("session_busy");
    const after = await late.ok({ type: "get_state" });
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.sessionFile).toBe(before.sessionFile);
    expect(await held(util, fx.id)).toEqual([fx.id]); // the refusal did not disturb the owner
  });

  test("a refusal leaves a live run and its queue alone", async () => {
    const fx = writeFixture(rig);
    const owner = await rig.spawn();
    await owner.send({ type: "switch_session", sessionPath: fx.path, claimLease: true });
    const busy = await rig.spawn();
    rig.setScript({ turns: [{ when: "SLOWRUN", steps: [{ text: "working" }, { sleep: 700 }, { text: " more" }] }] });
    const m = busy.mark();
    busy.fire({ type: "prompt", message: "SLOWRUN go" });
    await busy.waitType("agent_start", { from: m });
    await busy.send({ type: "follow_up", message: "queued after" });
    const refused = await busy.send({ type: "switch_session", sessionPath: fx.path, claimLease: true });
    expect(refused.code).toBe("session_busy");
    expect(((await busy.ok({ type: "get_state" })).isStreaming)).toBe(true);
    await busy.settled(m);
    const frames = busy.frames.slice(m);
    expect(frames.filter((f) => f.type === "agent_end")).toHaveLength(1);
    expect(frames.filter((f) => f.type === "prompt_result").map((f) => f.status)).toEqual(["completed"]);
    const texts = frames.filter((f) => f.type === "message_start" && f.message?.role === "user").map((f) => f.message.content[0].text);
    expect(texts).toEqual(["SLOWRUN go", "queued after"]);
  });

  test("without the flag the same switch opens the session and holds no lease until the first write", async () => {
    const fx = writeFixture(rig);
    const owner = await rig.spawn();
    const util = await rig.spawn();
    await owner.send({ type: "switch_session", sessionPath: fx.path, claimLease: true });
    const other = await rig.spawn();
    expect((await other.send({ type: "switch_session", sessionPath: fx.path })).success).toBe(true);
    const plain = writeFixture(rig);
    await other.send({ type: "switch_session", sessionPath: plain.path });
    expect(await held(util, plain.id)).toEqual([]);
  });

  test("the claimed session is written in place: no sibling transcript, same id", async () => {
    const fx = writeFixture(rig);
    const c = await rig.spawn();
    await c.send({ type: "switch_session", sessionPath: fx.path, claimLease: true });
    const files = rig.transcripts().length;
    rig.setScript({ turns: [] });
    const m = c.mark();
    await c.send({ type: "prompt", message: "write here" });
    await c.settled(m);
    expect(rig.transcripts().length).toBe(files);
    const state = await c.ok({ type: "get_state" });
    expect(state.sessionId).toBe(fx.id);
    expect(state.sessionFile).toBe(fx.path);
    expect(readTranscript(fx.path).some((l) => l.type === "message" && l.message?.content?.[0]?.text === "write here")).toBe(true);
  });

  test("a path with no readable session header fails without a code", async () => {
    const c = await rig.spawn();
    const junk = join(rig.root, "junk.jsonl");
    writeFileSync(junk, "not a session\n");
    for (const sessionPath of [join(rig.root, "nope.jsonl"), junk]) {
      const r = await c.send({ type: "switch_session", sessionPath, claimLease: true });
      expect(r.success).toBe(false);
      expect(String(r.error)).toContain("No session found at");
      expect(r.code).toBeUndefined();
    }
  });

  test("leaving a session (switch, new_session, fork) gives up its lease; the process dying gives up the rest", async () => {
    const a = writeFixture(rig);
    const b = writeFixture(rig);
    const c = await rig.spawn();
    const util = await rig.spawn();
    await c.send({ type: "switch_session", sessionPath: a.path, claimLease: true });
    expect(await held(util, a.id, b.id)).toEqual([a.id]);
    await c.send({ type: "switch_session", sessionPath: b.path, claimLease: true });
    expect(await held(util, a.id, b.id)).toEqual([b.id]);

    await c.send({ type: "new_session" });
    const fresh = (await c.ok({ type: "get_state" })).sessionId as string;
    expect(await held(util, b.id, fresh)).toEqual([fresh]);

    await c.send({ type: "switch_session", sessionPath: a.path, claimLease: true });
    await c.send({ type: "fork", entryId: a.ids.a2 });
    const fork = (await c.ok({ type: "get_state" })).sessionId as string;
    expect(await held(util, a.id, fork)).toEqual([fork]);

    await c.crash();
    await sleep(200);
    expect(await held(util, a.id, fork)).toEqual([]);
    // and the next claimer gets it
    const next = await rig.spawn();
    const r = await next.send({ type: "switch_session", sessionPath: a.path, claimLease: true });
    expect(must(r, "response").success).toBe(true);
  });
});
