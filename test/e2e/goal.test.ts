// omp's goal mode through the sidecar's `/goal` command. OpenChamber's own "Session goal" is switched off
// (stack.ts settings); the goal's state is served at /api/omp/goal/:sessionId for the Oh-My-Pi panel.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { startStack, type Stack } from "./stack";
import { composer, newSession, send } from "./ui";

let stack: Stack;
let page: Page;

beforeAll(async () => {
  stack = await startStack();
  page = await stack.page();
  await page.goto(stack.ui);
  await page.locator(".group\\/project").first().waitFor();
});
afterAll(() => stack.stop());

const dir = () => encodeURIComponent(stack.project);
/** The session this test just created: the newest by creation time (list order follows `updated`, which an earlier test's late write can move). */
const sessionId = async () => {
  const list = (await stack.http(`/session?directory=${dir()}`)).body.data as Array<{ id: string; time: { created: number } }>;
  return list.reduce((newest, s) => (s.time.created > newest.time.created ? s : newest)).id;
};
const status = async (id: string) => (await stack.http(`/session/status?directory=${dir()}`)).body?.[id]?.type ?? "idle";
const goalOf = async (id: string) => (await stack.http(`/api/omp/goal/${id}?directory=${dir()}`)).body;
const goalCommand = (id: string, args: string) => stack.http(`/session/${id}/command?directory=${dir()}`, { json: { command: "goal", arguments: args } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what: string, probe: () => Promise<boolean> | boolean, ms = 30_000) => {
  const start = Date.now();
  while (!(await probe())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};

describe("omp's goal mode via /goal", () => {
  test("typed in the composer: omp runs the goal to completion, and the endpoint follows it", async () => {
    stack.script([
      { when: "(#2)", steps: [{ text: "all done" }, { goalComplete: true }] },
      { when: "session goal", steps: [{ tool: "bash", args: { command: "ls" }, result: "file" }, { sleep: 1_500 }, { text: "working" }] },
    ]);
    await newSession(page);
    await send(page, "hello");
    await page.getByText("Echo: hello").waitFor();
    const id = await sessionId();
    // OpenChamber's own goal feature is off: no goal button in the composer.
    expect(await page.getByRole("button", { name: /goal/i }).count()).toBe(0);
    expect((await goalOf(id)).goal).toBeNull();

    await send(page, "/goal ship it");
    await until("omp's goal", () => stack.frames().some((f) => f.type === "goal" && f.op === "create" && f.objective === "ship it"));
    await until("an active goal", async () => (await goalOf(id)).goal?.status === "active");
    expect((await goalOf(id)).live).toBe(true);

    // The command is the user's message in the conversation.
    await page.getByText("/goal ship it").first().waitFor();
    await page.getByText("all done").first().waitFor({ timeout: 30_000 });
    await until("the completed goal", async () => (await goalOf(id)).goal?.status === "complete");
    expect((await goalOf(id)).goal).toMatchObject({ status: "complete", objective: "ship it" });
    await until("idle", async () => (await status(id)) === "idle");
    // The command was the only thing sent: omp ran the continuations, nothing prompted from OpenChamber.
    expect(stack.frames().filter((f) => f.type === "prompt").map((f) => f.message)).toEqual(["hello"]);

    // After a sidecar restart (no live omp), the transcript still says how the goal ended, and the
    // command is still the user's message, right before the goal's run.
    await stack.restartSidecar();
    expect(await goalOf(id)).toMatchObject({ live: false, goal: { status: "complete", objective: "ship it" } });
    const users = ((await stack.http(`/session/${id}/message?directory=${dir()}&order=asc`)).body.data as any[]).filter((m) => m.type === "user").map((m) => m.text);
    expect(users.slice(0, 2)).toEqual(["hello", "/goal ship it"]);
  });

  test("a /goal as the first message is refused, and its text stays in the composer", async () => {
    await newSession(page);
    const sessionsBefore = (await stack.http(`/session?directory=${dir()}`)).body.data.length;
    await send(page, "/goal too early");
    await page.getByText("A goal can't be the first message of a session").first().waitFor();
    await until("the text back in the composer", async () => (await composer(page).innerText()).includes("/goal too early"), 5_000);
    expect(stack.frames().some((f) => f.type === "goal" && f.objective === "too early")).toBe(false);
    // OpenChamber created the session before the command was refused; nothing was started in it.
    expect((await stack.http(`/session?directory=${dir()}`)).body.data.length).toBe(sessionsBefore + 1);
  });

  test("/goal is offered in the composer's command autocomplete", async () => {
    await newSession(page);
    await composer(page).click();
    await page.keyboard.type("/goa");
    await page.getByText("omp goal mode: /goal <objective> | pause | resume | drop", { exact: false }).first().waitFor();
    await page.keyboard.press("Escape");
    await composer(page).fill("");
  });

  test("pause, resume and drop; refusals explain themselves", async () => {
    stack.script([{ when: "session goal", steps: [{ tool: "bash", args: { command: "sleep" }, result: "ok" }, { sleep: 400 }, { text: "step" }] }]);
    await newSession(page);
    await send(page, "start");
    await page.getByText("Echo: start").waitFor();
    const id = await sessionId();

    expect((await goalCommand(id, "pause")).body).toMatchObject({ _tag: "InvalidRequestError", message: "No active goal to pause." });
    expect((await goalCommand(id, "")).body).toMatchObject({ error: expect.stringContaining("No goal") });
    expect((await goalCommand(id, "set keep going")).status).toBe(204);
    await until("an active goal", async () => (await goalOf(id)).goal?.status === "active");
    expect((await goalCommand(id, "another one")).body).toMatchObject({ error: expect.stringContaining("already active") });

    expect((await goalCommand(id, "pause")).status).toBe(204);
    expect((await goalOf(id)).goal).toMatchObject({ status: "paused", objective: "keep going" });
    expect((await goalCommand(id, "resume")).status).toBe(204);
    expect((await goalOf(id)).goal?.status).toBe("active");
    expect((await goalCommand(id, "drop")).status).toBe(204);
    expect((await goalOf(id)).goal).toBeNull();
    await until("idle", async () => (await status(id)) === "idle");
    // A fresh read of the transcript agrees: the goal was dropped.
    await stack.restartSidecar();
    expect(await goalOf(id)).toMatchObject({ live: false, goal: null });
  });

  test("goal with background work: the parent is idle while the job runs, the goal resumes after the wake", async () => {
    stack.script([
      { when: "(#2)", steps: [{ text: "goal reached" }, { goalComplete: true }] },
      { when: "(#1)", steps: [{ text: "starting the job" }, { tool: "bash", args: { command: "sleep 2", async: true }, result: "job output", asyncMs: 2_500 }, { text: "job started" }] },
      { when: "Background job", steps: [{ tool: "bash", args: { command: "cat out" }, result: "used the result" }, { text: "digested the result" }] },
    ]);
    await newSession(page);
    await send(page, "kickoff");
    await page.getByText("Echo: kickoff").waitFor();
    const id = await sessionId();
    expect((await goalCommand(id, "run the job")).status).toBe(204);

    // The job is running in the background: the parent run is over, so the parent is idle and the goal still active.
    await page.getByText("job started").first().waitFor({ timeout: 30_000 });
    for (let i = 0; i < 40 && (await status(id)) !== "idle"; i++) await sleep(50);
    const gap: string[] = [];
    for (let i = 0; i < 8; i++) {
      gap.push(await status(id));
      await sleep(100);
    }
    expect(gap).toEqual(Array(8).fill("idle"));
    expect((await goalOf(id)).goal?.status).toBe("active");
    expect(await page.getByText("digested the result").first().isVisible()).toBe(false);

    // The job's result wakes the parent; it made progress, so omp continues the goal and the agent completes it.
    await page.getByText("goal reached").first().waitFor({ timeout: 30_000 });
    await until("the completed goal", async () => (await goalOf(id)).goal?.status === "complete");
    expect(await page.getByText("digested the result").first().isVisible()).toBe(true);
    expect(stack.frames().filter((f) => f.type === "prompt").map((f) => f.message).at(-1)).toBe("kickoff");
  });

  test("OpenChamber's goal progress check, should its goal loop run, is answered without a model", async () => {
    const prompt = "You check the progress of an AI coding agent. Answer three yes/no questions and return exactly one JSON object.\n\n<objective>\nx\n</objective>\n\n<answer>\ny\n</answer>";
    const res = await stack.http(`/experimental/generate/text?directory=${dir()}`, { json: { prompt, model: { providerID: "stub", id: "fast" } } });
    expect(JSON.parse(res.body.text)).toEqual({ all_done: false, remaining: false, needs_user: true });
    expect(stack.frames().filter((f) => f.type === "print")).toEqual([]);
  });
});
