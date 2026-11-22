import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { startStack, type Stack } from "./stack";
import { newSession, send } from "./ui";

let stack: Stack;
let page: Page;
const failed: string[] = [];

/** Failures OpenChamber's own web server produces (GitHub binding, worktree archives): not the sidecar's. */
const openChamberOwned = /\/api\/(source-control|git\/worktrees)\//;

beforeAll(async () => {
  stack = await startStack();
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: stack.project });
  git("init", "-q", "-b", "main");
  writeFileSync(join(stack.project, "a.txt"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(stack.project, "a.txt"), "hello\nchanged line\n");

  page = await stack.page();
  page.on("response", (r) => {
    if (r.status() >= 400 && !openChamberOwned.test(r.url())) failed.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^http:\/\/[^/]+/, "")}`);
  });
  await page.goto(stack.ui);
  await page.locator(".group\\/project").first().waitFor();
  await newSession(page);
  await send(page, "hello panels");
  await page.getByText("Echo: hello panels").waitFor();
});
afterAll(async () => {
  await stack.stop();
});

const rail = (name: string) => page.getByRole("button", { name, exact: true }).first();
async function openPanel(name: string) {
  await rail(name).click();
}

describe("side panels", () => {
  test("Git shows the branch and the working-tree change", async () => {
    await openPanel("Git");
    await page.getByText("main", { exact: true }).first().waitFor();
    await page.getByText("a.txt").first().waitFor();
  });

  test("Changes shows the diff", async () => {
    await openPanel("Changes");
    await page.getByText("a.txt").first().waitFor();
  });

  test("Files lists the project", async () => {
    await openPanel("Files");
    await page.locator("text=a.txt >> visible=true").first().waitFor();
  });

  test("Terminal runs a command", async () => {
    await openPanel("Terminal");
    // The terminal is drawn on a canvas, so check its effect on disk instead of its text.
    await page.waitForTimeout(2500); // the shell is up
    await page.mouse.click(1000, 400);
    await page.keyboard.type("echo terminal-says-$((20+22)) > term.out");
    await page.keyboard.press("Enter");
    const out = join(stack.project, "term.out");
    for (let i = 0; i < 50 && !existsSync(out); i++) await Bun.sleep(100);
    expect(readFileSync(out, "utf8").trim()).toBe("terminal-says-42");
  });

  test("Project knowledge keeps a note", async () => {
    await openPanel("Project knowledge");
    await page.getByPlaceholder(/Capture context/).fill("remember the milk");
    await page.getByText("Add", { exact: true }).last().click();
    await page.getByText("remember the milk").first().waitFor();
    await page.reload();
    await openPanel("Project knowledge");
    await page.getByText("remember the milk").first().waitFor();
  });

  test("Project todos keep an item", async () => {
    await openPanel("Project knowledge");
    await page.getByText("Todo", { exact: true }).first().click();
    await page.getByPlaceholder("Add a todo").fill("buy bread");
    await page.getByText("Add", { exact: true }).last().click();
    await page.getByText("buy bread").first().waitFor();
    const id = `path_${Buffer.from(stack.project).toString("base64url")}`;
    await Bun.sleep(500);
    expect(JSON.stringify((await stack.http(`/api/project-context/${id}`)).body)).toContain("buy bread");
  });

  test("Context, Walkthrough and Browser open", async () => {
    for (const name of ["Context", "Walkthrough", "Browser"]) {
      await openPanel(name);
      await page.waitForTimeout(500);
    }
  });
});

describe("pages", () => {
  test("Stats counts the conversation", async () => {
    await page.getByText("Stats", { exact: true }).first().click();
    await page.getByText("Prompts").first().waitFor();
    await page.getByText("Daily activity").waitFor();
    expect(await page.getByText("Couldn't load stats").count()).toBe(0);
  });

  for (const name of ["Issues and PRs", "Scheduled tasks", "Archive", "Integrations catalog"]) {
    test(`${name} opens`, async () => {
      await page.getByText(name, { exact: true }).first().click();
      await page.waitForTimeout(800);
      expect(await page.getByText(/couldn't load|unexpected status/i).count()).toBe(0);
    });
  }

  test("an archived session moves to Archive", async () => {
    await page.getByRole("button", { name: "Archive", exact: true }).first().click({ force: true });
    await page.getByText("Archive", { exact: true }).first().click();
    await page.getByText(/hello panels|Session /).first().waitFor();
  });

  test("Settings opens", async () => {
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.waitForTimeout(800);
  });

  test("the sidecar served every request those panels made", () => {
    expect(failed).toEqual([]);
  });
});
