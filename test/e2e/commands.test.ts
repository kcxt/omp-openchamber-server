import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "./stack";

let stack: Stack;
beforeAll(async () => { stack = await startStack(); });
afterAll(() => stack.stop());

const dir = () => `directory=${encodeURIComponent(stack.project)}`;
const createSession = async (): Promise<string> =>
  (await stack.http(`/session?${dir()}`, { json: {} })).body.data.id;

describe("slash commands", () => {
  test("omp's plugin commands are listed", async () => {
    const { body } = await stack.http(`/command?${dir()}`);
    expect(body.data.map((c: any) => c.name)).toContain("pi-vcc");
  });

  test("POST /session/:id/command with only name and arguments reaches omp as `/name args`", async () => {
    const id = await createSession();
    const res = await stack.http(`/session/${id}/command?${dir()}`, { json: { command: "pi-vcc", arguments: "now" } });
    expect(res.status).toBe(204);
    await Bun.sleep(1000);
    expect(stack.frames().some((f) => f.type === "prompt" && f.message === "/pi-vcc now")).toBe(true);
  });

  test("a command's notify message becomes the assistant reply instead of an unanswered turn", async () => {
    const id = await createSession();
    await stack.http(`/session/${id}/command?${dir()}`, { json: { command: "pi-vcc" } });
    await Bun.sleep(1500);
    const blocks = ((await stack.http(`/session/${id}/message?${dir()}`)).body.data as any[]).flatMap((m) => m.content ?? []);
    expect(blocks.some((b: any) => b.type === "text" && String(b.text).includes("Nothing to compact yet."))).toBe(true);
  });

  test("a command without arguments is accepted too", async () => {
    const id = await createSession();
    const res = await stack.http(`/session/${id}/command?${dir()}`, { json: { name: "pi-vcc" } });
    expect(res.status).toBe(204);
  });
});

describe("streaming", () => {
  test("reasoning deltas patch the reasoning part's `text`", async () => {
    stack.script([{ when: "think", steps: [{ thinking: "weighing the options carefully" }, { text: "Done." }] }]);
    const id = await createSession();
    const events: any[] = [];
    const ctl = new AbortController();
    const stream = fetch(`${stack.api}/event?${dir()}`, { signal: ctl.signal }).then(async (res) => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as any) {
        buf += decoder.decode(chunk);
        const frames = buf.split("\n\n");
        buf = frames.pop()!;
        for (const frame of frames) {
          const data = frame.split("\n").find((l) => l.startsWith("data:"));
          if (data) try { const e = JSON.parse(data.slice(5)); if (e.data?.sessionID === id) events.push(e); } catch { /* keepalive */ }
        }
      }
    }).catch(() => {});
    await Bun.sleep(300);
    await stack.http(`/session/${id}/prompt_async?${dir()}`, { json: { parts: [{ type: "text", text: "think hard" }] } });
    const start = Date.now();
    while (Date.now() - start < 20_000 && !events.some((e) => e.type === "session.text.ended")) await Bun.sleep(100);
    ctl.abort();
    await stream;

    const types = events.map((e) => e.type);
    expect(types.indexOf("session.reasoning.started")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("session.reasoning.started")).toBeLessThan(types.indexOf("session.text.started"));
    const deltas = events.filter((e) => e.type === "session.reasoning.delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((e) => e.data.delta).join("")).toBe("weighing the options carefully");
    expect(events.find((e) => e.type === "session.reasoning.ended")?.data.text).toBe("weighing the options carefully");
    // Reasoning never leaks into the answer's text stream.
    expect(events.filter((e) => e.type === "session.text.delta").map((e) => e.data.delta).join("")).toBe("Done.");
  });
});
