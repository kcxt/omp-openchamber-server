import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "./stack";

let stack: Stack;
beforeAll(async () => { stack = await startStack(); });
afterAll(() => stack.stop());

const dir = () => `directory=${encodeURIComponent(stack.project)}`;
const createSession = async (): Promise<string> =>
  (await stack.http(`/session?${dir()}`, { json: {} })).body.data.id;
const prompt = async (id: string, text: string) => {
  await stack.http(`/session/${id}/prompt_async?${dir()}`, { json: { parts: [{ type: "text", text }] } });
  await Bun.sleep(1500);
};

describe("commands that start no agent turn", () => {
  const textsOf = async (id: string) =>
    ((await stack.http(`/session/${id}/message?${dir()}`)).body.data as any[]).flatMap((m) => m.content ?? [])
      .filter((b: any) => b.type === "text").map((b: any) => String(b.text));

  test("a manual compaction omp declines explains why instead of leaving the command unanswered", async () => {
    const id = await createSession();
    await stack.http(`/session/${id}/command?${dir()}`, { json: { command: "pi-vcc", arguments: "skip" } });
    await Bun.sleep(1500);
    expect((await textsOf(id)).some((t) => t.includes("Nothing to compact: the session is empty."))).toBe(true);
  });

  test("a builtin command's output becomes the reply", async () => {
    const id = await createSession();
    await stack.http(`/session/${id}/command?${dir()}`, { json: { command: "pi-vcc", arguments: "output" } });
    await Bun.sleep(1500);
    expect((await textsOf(id)).some((t) => t.includes("Context: 40 of 100000 tokens used."))).toBe(true);
  });
});

describe("omp's context map", () => {
  test("GET /api/omp/context/:id reports the prompt size the provider recorded", async () => {
    const id = await createSession();
    await prompt(id, "hello");
    const { status, body } = await stack.http(`/api/omp/context/${id}?${dir()}`);
    expect(status).toBe(200);
    expect(body.version).toBe(1);
    expect(body.current).toMatchObject({ used: 100, nonMessage: 40 });
    expect(body.history).toHaveLength(1);
    expect(body.breakdown).toBeNull();
  });

  test("?breakdown=1 adds omp's category totals", async () => {
    const id = await createSession();
    await prompt(id, "hello");
    const { body } = await stack.http(`/api/omp/context/${id}?${dir()}&breakdown=1`);
    expect(body.breakdown?.categories?.map((c: any) => c.id)).toEqual(["systemPrompt", "systemTools", "systemContext", "instructionFiles", "skills", "messages"]);
  });

  test("the session record and its messages still publish the context fields", async () => {
    const id = await createSession();
    await prompt(id, "hello");
    const session = (await stack.http(`/session/${id}?${dir()}`)).body.data;
    const messages = (await stack.http(`/session/${id}/message?${dir()}&limit=500`)).body.data;
    expect(session.metadata?.openchamber?.context?.used).toBe(100);
    expect(messages.some((m: any) => m.metadata?.omp?.context?.used === 100)).toBe(true);
  });
});
