import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { startStack, type Stack } from "./stack";
import { newSession, pickModel, send } from "./ui";

let stack: Stack;
let page: Page;

beforeAll(async () => {
  // Release idle children quickly so the next prompt respawns omp from the file.
  stack = await startStack({ env: { OC_CHILD_IDLE_MS: "300" } });
  page = await stack.page();
  await page.goto(stack.ui);
  await page.locator(".group\\/project").first().waitFor();
});
afterAll(() => stack.stop());

describe("history survives a respawned omp child", () => {
  test("after a model switch and the view/metadata markers a turn leaves behind", async () => {
    stack.script([{ when: "count", steps: [{ text: "users={{users}}" }] }]);
    await newSession(page);
    await send(page, "one");
    await page.getByText("Echo: one").waitFor();
    await pickModel(page, "Stub Fast", "Stub Smart");
    await send(page, "two");
    await page.getByText("Echo: two").waitFor();
    await page.waitForTimeout(1500); // idle release kills the child
    await send(page, "count");
    await page.getByText("users=3").waitFor();

    // omp replays its transcript as a tree: a line without an id would leave the
    // leaf undefined and wipe the history on the next load.
    for (const file of stack.sessionFiles()) {
      for (const record of file.records) {
        if (record.type === "session" || record.type === "title") continue;
        expect({ type: record.type, id: typeof record.id }).toEqual({ type: record.type, id: "string" });
      }
    }
  });
});
