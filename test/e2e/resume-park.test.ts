// `.` while omp has not admitted the resume yet (parked behind a compaction, §11.5): the sidecar's request deadline
// passes, but that is not a refusal. The turn stays open, the `.` bubble is delivered when the continuation starts, and
// no session.error closes the turn in OpenChamber.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "./stack";

const PARK_MS = 33_000; // longer than the sidecar's 30 s request deadline

let stack: Stack;
beforeAll(async () => { stack = await startStack({ env: { OMP_STUB_TICK_MS: "40", OMP_STUB_RESUME_PARK_MS: String(PARK_MS) } }); });
afterAll(() => stack.stop());

const dir = () => `directory=${encodeURIComponent(stack.project)}`;

describe("resume omp has not admitted yet", () => {
  test("the deadline is not a failure: no session.error, the `.` is delivered once the continuation starts", async () => {
    stack.script([]);
    const id = (await stack.http(`/session?${dir()}`, { json: {} })).body.data.id;

    const events: Array<{ type: string; data: any; at: number }> = [];
    const ctl = new AbortController();
    const reading = fetch(`${stack.api}/event?${dir()}`, { signal: ctl.signal }).then(async (res) => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as any) {
        buf += decoder.decode(chunk);
        const frames = buf.split("\n\n");
        buf = frames.pop()!;
        for (const frame of frames) {
          const data = frame.split("\n").find((l) => l.startsWith("data:"));
          if (data) try { const e = JSON.parse(data.slice(5)); events.push({ type: e.type, data: e.data, at: Date.now() }); } catch { /* keepalive */ }
        }
      }
    }).catch(() => {});
    const ours = (type: string) => events.filter((e) => e.type === type && e.data?.sessionID === id);
    const until = async (what: string, probe: () => boolean, timeoutMs: number) => {
      const start = Date.now();
      while (!probe()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(100);
      }
    };
    const ended = () => events.filter((e) => e.data?.sessionID === id && ["session.execution.succeeded", "session.execution.interrupted"].includes(e.type)).length;
    await Bun.sleep(300);

    await stack.http(`/session/${id}/prompt_async?${dir()}`, { json: { parts: [{ type: "text", text: "first words" }] } });
    await until("the first turn to end", () => ended() > 0, 20_000);
    await Bun.sleep(500);
    const before = ended();

    const sent = Date.now();
    const res = await stack.http(`/session/${id}/prompt_async?${dir()}`, { json: { id: "msg_parkC0001", parts: [{ type: "text", text: "." }] } });
    const waited = Date.now() - sent;
    expect(res.status).toBe(200);
    // The request returned at the deadline, before omp admitted the continuation.
    expect(waited).toBeGreaterThanOrEqual(29_000);
    expect(waited).toBeLessThan(PARK_MS);
    expect(ours("session.error")).toHaveLength(0);
    expect(ours("session.inbox.delivered").some((e) => e.data.inboxID === "msg_parkC0001")).toBe(false);

    await until("the continuation to be delivered", () => ours("session.inbox.delivered").some((e) => e.data.inboxID === "msg_parkC0001"), 30_000);
    await until("the continuation to finish", () => ended() > before, 30_000);
    ctl.abort();
    await reading;
    expect(ours("session.error")).toHaveLength(0);
    const delivered = ours("session.inbox.delivered").filter((e) => e.data.inboxID === "msg_parkC0001");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.at - sent).toBeGreaterThanOrEqual(PARK_MS - 500);
  }, 90_000);
});
