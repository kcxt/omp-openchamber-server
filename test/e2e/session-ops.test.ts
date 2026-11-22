// Session operations that go through omp (PLAN §3.9, D4): revert/redo through the tree, rename through
// `set_session_name`, move through the builtin `/move`. API-level: no browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startStack, type Stack } from "./stack";

let stack: Stack;
beforeAll(async () => {
  // A short idle release, so a test can have the omp child go away between two steps.
  stack = await startStack({ env: { OC_CHILD_IDLE_MS: "300" } });
});
afterAll(() => stack.stop());

const dir = () => `directory=${encodeURIComponent(stack.project)}`;
const createSession = async (): Promise<string> => (await stack.http(`/session?${dir()}`, { json: {} })).body.data.id;
const send = (id: string, messageID: string, text: string) =>
  stack.http(`/session/${id}/prompt_async?${dir()}`, { json: { id: messageID, parts: [{ type: "text", text }] } });
const messages = async (id: string): Promise<string[]> =>
  ((await stack.http(`/session/${id}/message?${dir()}&order=asc`)).body.data as any[]).map((m) =>
    m.type === "user" ? `user: ${m.text}` : `assistant: ${(m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("")}`);
async function until(what: string, probe: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}
/** A prompt, sent and answered. */
async function converse(id: string, messageID: string, text: string, expected: number): Promise<void> {
  expect((await send(id, messageID, text)).status).toBeLessThan(300);
  await until(`${text} answered`, async () => (await messages(id)).length >= expected);
  await until("idle", async () => Object.keys((await stack.http(`/session/status?${dir()}`)).body).length === 0);
}
const opened = () => stack.frames().filter((f) => f.type === "switch_session").length;
const fileOf = (marker: string) => stack.sessionFiles().find((f) => JSON.stringify(f.records).includes(marker))!;

describe("revert and redo through omp's tree", () => {
  test("a revert is durable in the transcript and redo survives the child going away", async () => {
    const id = await createSession();
    await converse(id, "msg_opsrevert0001", "first question", 2);
    await converse(id, "msg_opsrevert0002", "second question", 4);

    const staged = await stack.http(`/session/${id}/revert/stage?${dir()}`, { json: { messageID: "msg_opsrevert0002" } });
    expect(staged.status).toBe(200);
    expect(await messages(id)).toEqual(["user: first question", "assistant: Echo: first question"]);

    // omp journaled the branch choice, so the file itself ends on the revert marker.
    const records = fileOf("second question").records;
    expect(records.at(-1)).toMatchObject({ type: "custom", customType: "host-revert" });

    // The child leaves; the revert is still the transcript's.
    const before = opened();
    await Bun.sleep(2_000);
    expect(await messages(id)).toEqual(["user: first question", "assistant: Echo: first question"]);

    // Redo needs a new child, which finds the abandoned branch again.
    expect((await stack.http(`/session/${id}/revert?${dir()}`, { method: "DELETE" })).status).toBe(204);
    expect(opened()).toBeGreaterThan(before);
    expect(await messages(id)).toEqual([
      "user: first question",
      "assistant: Echo: first question",
      "user: second question",
      "assistant: Echo: second question",
    ]);
    expect(fileOf("second question").records.at(-1)).toMatchObject({ type: "custom", customType: "host-revert" });
  });

  test("a prompt after a revert continues from the reverted branch", async () => {
    const id = await createSession();
    await converse(id, "msg_opsrevert0011", "keep this", 2);
    await converse(id, "msg_opsrevert0012", "drop this", 4);
    expect((await stack.http(`/session/${id}/revert/stage?${dir()}`, { json: { messageID: "msg_opsrevert0012" } })).status).toBe(200);
    await converse(id, "msg_opsrevert0013", "replace it", 4);
    expect(await messages(id)).toEqual(["user: keep this", "assistant: Echo: keep this", "user: replace it", "assistant: Echo: replace it"]);
    // The staged marker went with the prompt; there is nothing left to redo.
    expect((await stack.http(`/session/${id}/revert/commit?${dir()}`, { json: {} })).status).toBe(409);
  });
});

describe("renaming", () => {
  test("goes through omp: set_session_name, and omp writes the title slot", async () => {
    const id = await createSession();
    await converse(id, "msg_opsrename0001", "something to title", 2);
    expect((await stack.http(`/session/${id}?${dir()}`, { method: "PATCH", json: { title: "Renamed by the user" } })).status).toBe(204);

    expect(stack.frames().some((f) => f.type === "set_session_name" && f.name === "Renamed by the user")).toBe(true);
    const slot = fileOf("something to title").records[0]!;
    // The sidecar's own slot rewrite marked its titles `source: "user"`; omp's carries no source.
    expect(slot).toMatchObject({ type: "title", title: "Renamed by the user" });
    expect(slot.source).toBeUndefined();
    expect((await stack.http(`/session/${id}?${dir()}`)).body.data.title).toBe("Renamed by the user");
  });
});

describe("moving to another directory", () => {
  test("is omp's /move: same session, new directory, file in the new bucket", async () => {
    const id = await createSession();
    await converse(id, "msg_opsmove0001", "a session to move", 2);
    const moved = await stack.http(`/session/${id}/move?${dir()}`, { json: { directory: stack.outside } });
    expect(moved.status).toBe(204);

    expect(stack.frames().some((f) => f.type === "prompt" && f.message === `/move ${stack.outside}`)).toBe(true);
    const session = (await stack.http(`/session/${id}`)).body.data;
    expect(session.directory ?? session.location?.directory).toBe(stack.outside);
    expect(fileOf("a session to move").records.find((r) => r.type === "session")?.cwd).toBe(stack.outside);
    expect(await messages(id)).toEqual(["user: a session to move", "assistant: Echo: a session to move"]);
  });

  test("omp's refusal becomes an error and nothing moves", async () => {
    const id = await createSession();
    await converse(id, "msg_opsmove0011", "stay where you are", 2);
    const refused = await stack.http(`/session/${id}/move?${dir()}`, { json: { directory: `${stack.root}/does-not-exist` } });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain("Directory does not exist");
    expect(fileOf("stay where you are").records.find((r) => r.type === "session")?.cwd).toBe(stack.project);
  });
});
