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
    { when: "slow", steps: [{ text: "partial answer " }, { sleep: 20_000 }, { text: "never shown" }] },
    { when: "count", steps: [{ text: "context holds {{users}} user messages" }] },
  ]);
  page = await stack.page();
  await page.goto(stack.ui);
  await page.locator(".group\\/project").first().waitFor();
  await newSession(page);
});

const dir = () => encodeURIComponent(stack.project);
async function transcript(): Promise<string[]> {
  const sessions = (await stack.http(`/session?directory=${dir()}`)).body.data as Array<{ id: string }>;
  const messages = (await stack.http(`/session/${sessions[0]!.id}/message?directory=${dir()}&order=asc`)).body.data as any[];
  return messages.map((m) => (m.type === "user" ? `user: ${m.text}` : `assistant: ${(m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("")}`));
}
/** The user/assistant text omp has on its active branch, from the file it persists. */
function branchOnDisk(marker: string): string[] {
  const file = stack.sessionFiles().find((f) => JSON.stringify(f.records).includes(marker))!;
  const records = file.records.filter((r) => typeof r.id === "string" && r.type === "message");
  const byId = new Map(records.map((r) => [r.id, r]));
  const path: any[] = [];
  for (let n = records.at(-1); n; n = byId.get(n.parentId)) path.unshift(n);
  return path.map((r) => r.message.role === "user" ? `user: ${r.message.content[0].text}` : `assistant: ${r.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")}`);
}
const stop = () => page.getByRole("button", { name: "Stop generating" }).first();

describe("cancelling a turn", () => {
  test("leaves OpenChamber idle and consistent, and the session usable", async () => {
    await send(page, "slow please");
    await page.getByText("partial answer").waitFor(); // streamed live, before the turn ends
    await stop().click();
    await stop().waitFor({ state: "hidden" });

    // The next prompt goes through and the aborted turn does not linger or duplicate.
    await send(page, "count them");
    await page.getByText("context holds 2 user messages").waitFor();
    expect(await transcript()).toEqual([
      "user: slow please",
      "assistant: partial answer ",
      "user: count them",
      "assistant: context holds 2 user messages",
    ]);

    await page.reload();
    await page.getByText("context holds 2 user messages").waitFor();
    expect(await page.getByText("partial answer").count()).toBe(1);
  });
});

describe("editing a message", () => {
  test("Revert to this message rewinds both OpenChamber and omp, and the edit replaces the turn", async () => {
    await send(page, "message one");
    await page.getByText("Echo: message one").waitFor();
    await send(page, "message two");
    await page.getByText("Echo: message two").waitFor();

    await page.getByText("message two", { exact: true }).hover();
    await page.getByRole("button", { name: "Revert to this message" }).last().click();
    // The reverted turn is gone from view and its text is back in the composer.
    await page.getByText("Echo: message two").waitFor({ state: "hidden" });
    expect(await composer(page).innerText()).toContain("message two");

    await composer(page).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("count the edited message");
    await page.keyboard.press("Enter");
    // omp itself dropped the reverted message: it sees message one and the edit, not three.
    await page.getByText("context holds 2 user messages").waitFor();

    const expected = ["user: message one", "assistant: Echo: message one", "user: count the edited message", "assistant: context holds 2 user messages"];
    expect(await transcript()).toEqual(expected);
    expect(branchOnDisk("count the edited message")).toEqual(expected);
    expect(await page.getByText("message two", { exact: true }).count()).toBe(0);

    await page.reload();
    await page.getByText("context holds 2 user messages").waitFor();
    expect(await page.getByText("Echo: message two").count()).toBe(0);
  });

  test("Redo restores the reverted messages", async () => {
    await send(page, "message one");
    await page.getByText("Echo: message one").waitFor();
    await send(page, "message two");
    await page.getByText("Echo: message two").waitFor();
    await page.getByText("message two", { exact: true }).hover();
    await page.getByRole("button", { name: "Revert to this message" }).last().click();
    await page.getByText("Echo: message two").waitFor({ state: "hidden" });
    await page.getByText("Restore", { exact: true }).click();
    await page.getByText("Echo: message two").waitFor();
    expect((await transcript()).length).toBe(4);
  });
});

describe("forking from a message", () => {
  test("creates a session with the history before that message", async () => {
    await send(page, "message one");
    await page.getByText("Echo: message one").waitFor();
    await send(page, "message two");
    await page.getByText("Echo: message two").waitFor();
    await page.getByText("message two", { exact: true }).hover();
    await page.getByRole("button", { name: "More actions" }).first().click({ force: true });
    await page.getByRole("menuitem", { name: "Fork from here" }).click();
    await page.getByText("Echo: message one").waitFor();
    await page.getByText("Echo: message two").waitFor({ state: "hidden" });
  });
});
