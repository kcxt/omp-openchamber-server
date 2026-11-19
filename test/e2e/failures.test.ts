import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { startStack, type Stack } from "./stack";
import { composer, newSession, send } from "./ui";

let stack: Stack;
let page: Page;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

beforeEach(async () => {
  stack.script([
    { when: "overload", steps: [{ fail: "503 Service Unavailable: the model is overloaded" }] },
    { when: "segfault", steps: [{ text: "about to die " }, { sleep: 200 }, { crash: true }] },
    { when: "long running", steps: [{ text: "working " }, { sleep: 20_000 }, { text: "never" }] },
    { when: "count", steps: [{ text: "context holds {{users}} user messages" }] },
  ]);
  page = await stack.page();
  await page.goto(stack.ui);
  await page.locator(".group\\/project").first().waitFor();
  await newSession(page);
});

const dir = () => encodeURIComponent(stack.project);
const stop = () => page.getByRole("button", { name: "Stop generating" }).first();
const sessionId = async () => ((await stack.http(`/session?directory=${dir()}`)).body.data as Array<{ id: string }>)[0]!.id;
const status = async (id: string) => (await stack.http(`/session/status?directory=${dir()}`)).body?.[id]?.type ?? "idle";

describe("the model API fails", () => {
  test("the error is shown, the session goes idle and the next turn works", async () => {
    await send(page, "please overload");
    await page.getByText(/overloaded/).first().waitFor();
    await stop().waitFor({ state: "hidden" });
    expect(await status(await sessionId())).toBe("idle");

    await send(page, "count them");
    await page.getByText("context holds 2 user messages").waitFor();
  });

  test("the failure survives a reload as an error, not a silent empty turn", async () => {
    await send(page, "overload again");
    await page.getByText(/overloaded/).first().waitFor();
    await page.reload();
    await page.getByText(/overloaded/).first().waitFor();
  });
});

describe("the omp child dies", () => {
  test("mid-turn: the turn ends with an error and a fresh child takes the next prompt", async () => {
    await send(page, "segfault now");
    await page.getByText(/exited unexpectedly/).first().waitFor();
    await stop().waitFor({ state: "hidden" });
    expect(await status(await sessionId())).toBe("idle");

    const spawnsBefore = stack.frames().filter((f) => f.type === "switch_session").length;
    await send(page, "count them");
    await page.getByText("context holds 2 user messages").waitFor();
    expect(stack.frames().filter((f) => f.type === "switch_session").length).toBeGreaterThan(spawnsBefore);
  });
});

describe("the sidecar restarts", () => {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    test(`${signal}: history survives and the open page keeps working without a reload`, async () => {
      await send(page, "before the restart");
      await page.getByText("Echo: before the restart").waitFor();

      await stack.restartSidecar(signal);

      // The same tab: its event stream reconnects, the session is still there, a new prompt goes through.
      await send(page, "count after restart");
      await page.getByText(/context holds 2 user messages/).waitFor({ timeout: 45_000 });
      await page.reload();
      await page.getByText("Echo: before the restart").waitFor();
      await page.getByText(/context holds 2 user messages/).waitFor();
    });
  }

  test("a turn in flight when the sidecar dies ends idle after the restart", async () => {
    await send(page, "long running job");
    await stop().waitFor();
    await stack.restartSidecar("SIGKILL");

    await page.reload();
    await page.getByText("long running job").first().waitFor();
    await stop().waitFor({ state: "hidden", timeout: 45_000 });
    expect(await status(await sessionId())).toBe("idle");

    await composer(page).click();
    await page.keyboard.type("count them");
    await page.keyboard.press("Enter");
    await page.getByText(/context holds \d user messages/).waitFor();
  });
});
