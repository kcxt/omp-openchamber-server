// omp names a session itself (`--auto-title`) and emits no event when it does: the title lands in the
// transcript's title slot. The sidecar reads it after the run and tells OpenChamber (`session.renamed`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { startStack, type Stack } from "./stack";
import { newSession, send } from "./ui";

let stack: Stack;
let page: Page;

beforeAll(async () => {
  stack = await startStack();
  page = await stack.page();
  await page.goto(stack.ui);
  await page.locator(".group\\/project").first().waitFor();
});
afterAll(() => stack.stop());

describe("session titles", () => {
  test("a new session shows the title omp gave it in the sidebar", async () => {
    stack.script([], "Fixing the flaky login test");
    await newSession(page);
    await send(page, "please look into the login flake");
    await page.getByText("Echo: please look into the login flake").waitFor();

    // Without a reload: the sidebar and the session header learned the title from the sidecar's renamed event.
    const title = page.getByText("Fixing the flaky login test", { exact: true });
    await title.first().waitFor();
    await title.nth(1).waitFor();
    expect(await title.count()).toBe(2);
    // The title is omp's: it sits in the transcript's title slot, and the sidecar was asked for nothing.
    const file = stack.sessionFiles().find((f) => JSON.stringify(f.records).includes("login flake"));
    expect(file?.records[0]).toMatchObject({ type: "title", title: "Fixing the flaky login test" });
    expect(stack.frames().some((f) => f.type === "set_session_name")).toBe(false);
  });
});
