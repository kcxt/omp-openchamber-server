// R6: get_session_lease from a sessionless child while another child holds the lease.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Rig, sleep, writeFixture } from "./harness";

setDefaultTimeout(90_000);

const rig = new Rig();
afterAll(() => rig.close());
const NOBODY = "00000000-0000-0000-0000-000000000000";

describe(`R6 get_session_lease (${rig.kind})`, () => {
  test("a sessionless utility child sees a writer's lease, fast, and sees it released when the writer dies", async () => {
    const writer = await rig.spawn();
    const util = await rig.spawn();
    rig.setScript({ turns: [] });
    const m = writer.mark();
    await writer.send({ type: "prompt", message: "write something" });
    await writer.settled(m);
    const id = (await writer.send({ type: "get_state" })).data.sessionId as string;

    const probe = await util.send({ type: "get_session_lease", sessionIds: [id, NOBODY] });
    expect(probe.success).toBe(true);
    expect(probe.data.held).toEqual([id]);
    expect(probe.data.unknown).toEqual([]);

    // latency: the sidecar polls this per followed session
    const t0 = performance.now();
    const N = 20;
    for (let i = 0; i < N; i++) await util.send({ type: "get_session_lease", sessionIds: [id, NOBODY] });
    const avg = (performance.now() - t0) / N;
    console.log(`[contract:${rig.kind}] get_session_lease avg ${avg.toFixed(2)} ms over ${N} probes`);
    expect(avg).toBeLessThan(50);

    // the holder itself reports it too
    expect((await writer.send({ type: "get_session_lease", sessionIds: [id] })).data.held).toEqual([id]);

    await writer.crash();
    await sleep(200);
    expect((await util.send({ type: "get_session_lease", sessionIds: [id] })).data.held).toEqual([]);
  });

  test("open-but-unwritten: a process that has a session open and has not written holds no lease (the known gap)", async () => {
    const fx = writeFixture(rig);
    const opener = await rig.spawn();
    const util = await rig.spawn();
    await opener.send({ type: "switch_session", sessionPath: fx.path });
    expect((await util.send({ type: "get_session_lease", sessionIds: [fx.id] })).data.held).toEqual([]);
    // the lease is taken by the first write
    rig.setScript({ turns: [] });
    const m = opener.mark();
    await opener.send({ type: "prompt", message: "first write" });
    await opener.settled(m);
    expect((await util.send({ type: "get_session_lease", sessionIds: [fx.id] })).data.held).toEqual([fx.id]);
  });

  test("a fork's lease: held only once written (probe right after fork)", async () => {
    const fx = writeFixture(rig);
    const c = await rig.spawn();
    const util = await rig.spawn();
    await c.send({ type: "switch_session", sessionPath: fx.path });
    await c.send({ type: "fork", entryId: fx.ids.a2 });
    const forkId = (await c.send({ type: "get_state" })).data.sessionId as string;
    const held = (await util.send({ type: "get_session_lease", sessionIds: [forkId, fx.id] })).data.held as string[];
    console.log(`[contract:${rig.kind}] after fork: held=${JSON.stringify(held)} (fork ${forkId}, parent ${fx.id})`);
    expect(held).not.toContain(fx.id);
  });

  test("malformed input is an error, not a crash", async () => {
    const util = await rig.spawn();
    const r = await util.send({ type: "get_session_lease", sessionIds: "nope" });
    expect(r.success).toBe(false);
    expect((await util.send({ type: "get_state" })).success).toBe(true);
  });
});
