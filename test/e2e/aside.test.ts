// `/aside` (omp's `/btw`) as OpenChamber drives it: a side question answered beside the main conversation.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "./stack";

let stack: Stack;
beforeAll(async () => { stack = await startStack({ env: { OMP_STUB_TICK_MS: "20" } }); });
afterAll(() => stack.stop());

const dir = () => `directory=${encodeURIComponent(stack.project)}`;
const createSession = async (): Promise<string> => (await stack.http(`/session?${dir()}`, { json: {} })).body.data.id;
const prompt = (id: string, messageID: string, text: string) =>
  stack.http(`/session/${id}/prompt_async?${dir()}`, { json: { id: messageID, parts: [{ type: "text", text }] } });
const statusMap = async (): Promise<Record<string, { type: string }>> => (await stack.http(`/session/status?${dir()}`)).body;
const messages = async (id: string): Promise<string[]> =>
  ((await stack.http(`/session/${id}/message?${dir()}&order=asc`)).body.data as any[]).map((m) =>
    m.type === "user" ? `user: ${m.text}` : `assistant: ${(m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("")}`);

type Recorded = { type: string; data: any };
async function record() {
  const events: Recorded[] = [];
  const ctl = new AbortController();
  const done = fetch(`${stack.api}/event?${dir()}`, { signal: ctl.signal }).then(async (res) => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as any) {
      buf += decoder.decode(chunk);
      const frames = buf.split("\n\n");
      buf = frames.pop()!;
      for (const frame of frames) {
        const data = frame.split("\n").find((l) => l.startsWith("data:"));
        if (data) try { const e = JSON.parse(data.slice(5)); events.push({ type: e.type, data: e.data }); } catch { /* keepalive */ }
      }
    }
  }).catch(() => {});
  await Bun.sleep(300);
  return { events, async stop() { ctl.abort(); await done; } };
}
async function until(what: string, probe: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

describe("/aside", () => {
  test("during a busy turn it streams an answer, leaves the status alone, survives a reload and stays out of the main context", async () => {
    stack.script([
      { when: "long run", steps: [{ text: "working " }, { sleep: 2_500 }, { text: "done" }] },
      { when: "side question", steps: [{ text: "aside answer for {{users}}" }] },
      { when: "count", steps: [{ text: "context holds {{users}} user messages" }] },
    ]);
    const id = await createSession();
    const rec = await record();
    await prompt(id, "msg_aside_main0001", "long run");
    await until("the main run to be busy", async () => (await statusMap())[id]?.type === "busy");

    const sent = await stack.http(`/session/${id}/command?${dir()}`, { json: { command: "aside", arguments: "a side question about this" } });
    expect(sent.status).toBe(204);

    // The answer streams while the main run is still going, and the status never moved.
    await until("the aside answer", () => rec.events.some((e) => e.type === "session.text.ended" && String(e.data?.text).startsWith("aside answer")));
    expect((await statusMap())[id]?.type).toBe("busy");
    expect(rec.events.filter((e) => e.data?.sessionID === id && e.type === "session.text.delta" && String(e.data?.delta).length > 0).length).toBeGreaterThan(1);
    expect((await messages(id)).slice(-2)).toEqual(["user: /aside a side question about this", "assistant: aside answer for 1"]);

    await until("the main run to end", async () => (await statusMap())[id] === undefined);
    // One execution for the one run; the aside started none and ended none.
    const of = (type: string) => rec.events.filter((e) => e.type === type && e.data?.sessionID === id).length;
    expect(of("session.execution.started")).toBe(1);
    expect(of("session.execution.succeeded") + of("session.idle")).toBe(1);
    await rec.stop();

    // A fresh read, and a fresh sidecar, find the aside in omp's own btw history; the main conversation is unchanged.
    const afterMain = await messages(id);
    expect(afterMain.filter((m) => !m.includes("aside"))).toEqual(["user: long run", "assistant: working \ndone"]);
    expect(afterMain).toContain("user: /aside a side question about this");
    expect(afterMain).toContain("assistant: aside answer for 1");
    await stack.restartSidecar();
    expect(await messages(id)).toEqual(afterMain);

    // The main conversation's context never held the aside.
    await prompt(id, "msg_aside_main0002", "count them");
    await until("the count answer", async () => (await messages(id)).includes("assistant: context holds 2 user messages"));
  });

  test("a typed /aside on an idle session works, and the session stays idle", async () => {
    stack.script([{ when: "idle side question", steps: [{ text: "idle answer" }] }]);
    const id = await createSession();
    const res = await prompt(id, "msg_aside_idle0001", "/aside idle side question");
    expect(res.status).toBeLessThan(300);
    await until("the answer", async () => (await messages(id)).includes("assistant: idle answer"));
    expect((await messages(id))[0]).toBe("user: /aside idle side question");
    expect((await statusMap())[id]).toBeUndefined();
  });

  test("is listed among the commands", async () => {
    const { body } = await stack.http(`/command?${dir()}`);
    expect(body.data).toContainEqual({ name: "aside", description: "Ask a side question without adding it to the conversation (omp /btw)" });
  });

  test("an empty question is refused", async () => {
    const id = await createSession();
    const res = await stack.http(`/session/${id}/command?${dir()}`, { json: { command: "aside" } });
    expect(res.status).toBe(400);
  });
});
