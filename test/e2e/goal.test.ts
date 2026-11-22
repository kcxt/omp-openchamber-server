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

const dir = () => encodeURIComponent(stack.project);
/** The session this test just created: the newest by creation time (list order follows `updated`, which an earlier test's late write can move). */
const sessionId = async () => {
  const list = (await stack.http(`/session?directory=${dir()}`)).body.data as Array<{ id: string; time: { created: number } }>;
  return list.reduce((newest, s) => (s.time.created > newest.time.created ? s : newest)).id;
};
const status = async (id: string) => (await stack.http(`/session/status?directory=${dir()}`)).body?.[id]?.type ?? "idle";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("omp's own goal mode", () => {
  test("the agent completes the goal with its tool; OpenChamber's audit loop never prompts", async () => {
    stack.script([
      { when: "(#3)", steps: [{ text: "all done" }, { goalComplete: true }] },
      { when: "session goal", steps: [{ tool: "bash", args: { command: "ls" }, result: "file" }, { text: "working" }] },
    ]);
    await newSession(page);
    await send(page, "hello");
    await page.getByText("Echo: hello").waitFor();
    const id = await sessionId();

    // Armed the way OpenChamber's UI does it: through OpenChamber's metadata route, which stores the
    // goal (PATCHing the sidecar) and broadcasts it to the UI.
    const now = Date.now();
    const goal = { id: "goal1", objective: "ship it", objectiveFile: false, status: "active", tokenBudget: null, tokensUsed: 0, turnsUsed: 0, blockedStreak: 0, note: "", statusReason: "", lastAccountedMessageID: "", createdAt: now, updatedAt: now };
    const res = await fetch(`${stack.ui}/api/openchamber/sessions/${id}/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: { openchamber: { goal } }, directory: stack.project }),
    });
    expect(res.ok).toBe(true);

    // Between omp's goal turns the session must stay busy: an idle gap is what OpenChamber's loop acts on.
    const samples: string[] = [];
    const sampler = (async () => {
      while (samples.length < 400 && !samples.includes("done")) {
        samples.push(await status(id));
        await sleep(60);
      }
    })();
    // The UI shows the goal as running before omp finishes it.
    const row = page.getByRole("group", { name: "Session goal — open details" });
    await row.getByText(/^(Active|Evaluating…)$/).waitFor({ timeout: 15_000 });
    await page.getByText("all done").first().waitFor({ timeout: 30_000 });
    expect(stack.frames().some((f) => f.type === "goal" && f.op === "create" && f.objective === "ship it")).toBe(true);

    // omp's goal is mirrored into OpenChamber's record, so its loop sees a settled goal.
    let settled: any;
    for (let i = 0; i < 40 && settled?.status !== "complete"; i++) {
      settled = (await stack.http(`/session/${id}?directory=${dir()}`)).body?.data?.metadata?.openchamber?.goal;
      await sleep(250);
    }
    expect(settled?.status).toBe("complete");
    expect(settled?.statusReason).toBe("reported by agent");
    // The UI learns of the settled goal live (OpenCode's `session.metadata.updated`): the row it already
    // showed as running turns complete without a reload or refetch.
    await row.getByText("Complete", { exact: true }).waitFor({ timeout: 15_000 });
    for (let i = 0; i < 40 && (await status(id)) !== "idle"; i++) await sleep(100);
    expect(await status(id)).toBe("idle");
    samples.push("done");
    await sampler;
    const firstBusy = samples.indexOf("busy");
    expect(firstBusy).toBeGreaterThanOrEqual(0);
    expect(samples.slice(firstBusy, samples.lastIndexOf("busy")).includes("idle")).toBe(false);

    // Past OpenChamber's 3s idle window: its loop must not have sent a continuation prompt of its own.
    await sleep(6_000);
    const prompts = stack.frames().filter((f) => f.type === "prompt");
    expect(prompts.map((f) => f.message)).toEqual(["hello"]);
  });

  test("a goal omp stops continuing is blocked in OpenChamber instead of left active", async () => {
    stack.script([{ when: "session goal", steps: [{ text: "pondering" }] }]);
    await newSession(page);
    await send(page, "start");
    await page.getByText("Echo: start").waitFor();
    const id = await sessionId();
    const now = Date.now();
    const goal = { id: "goal2", objective: "think", objectiveFile: false, status: "active", tokenBudget: null, tokensUsed: 0, turnsUsed: 0, blockedStreak: 0, note: "", statusReason: "", lastAccountedMessageID: "", createdAt: now, updatedAt: now };
    await fetch(`${stack.ui}/api/session/${id}?directory=${dir()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { openchamber: { goal } } }),
    });
    let current: any;
    for (let i = 0; i < 80 && current?.status !== "blocked"; i++) {
      current = (await stack.http(`/session/${id}?directory=${dir()}`)).body?.data?.metadata?.openchamber?.goal;
      await sleep(250);
    }
    expect(current?.status).toBe("blocked");
    for (let i = 0; i < 40 && (await status(id)) !== "idle"; i++) await sleep(100);
    expect(await status(id)).toBe("idle");
  });

  test("resuming a blocked goal: OpenChamber's progress check is answered without asking a model", async () => {
    stack.script([{ when: "session goal", steps: [{ text: "pondering" }] }]);
    await newSession(page);
    await send(page, "begin");
    await page.getByText("Echo: begin").waitFor();
    const id = await sessionId();
    const record = async () => (await stack.http(`/session/${id}?directory=${dir()}`)).body?.data?.metadata?.openchamber?.goal;
    const writeGoal = async (goal: Record<string, unknown>) => {
      const res = await fetch(`${stack.ui}/api/openchamber/sessions/${id}/metadata`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ patch: { openchamber: { goal } }, directory: stack.project }),
      });
      expect(res.ok).toBe(true);
    };
    const now = Date.now();
    await writeGoal({ id: "goal5", objective: "ponder", objectiveFile: false, status: "active", tokenBudget: null, tokensUsed: 0, turnsUsed: 0, blockedStreak: 0, note: "", statusReason: "", lastAccountedMessageID: "", createdAt: now, updatedAt: now });
    let current: any;
    for (let i = 0; i < 80 && current?.status !== "blocked"; i++) {
      current = await record();
      await sleep(250);
    }
    expect(current?.status).toBe("blocked");
    for (let i = 0; i < 40 && (await status(id)) !== "idle"; i++) await sleep(100);

    // OpenChamber's Resume: its loop ticks 250 ms later, while the session is still idle, and runs its progress check.
    const resumesBefore = stack.frames().filter((f) => f.type === "goal" && f.op === "resume").length;
    await writeGoal({ ...current, status: "active", statusReason: "resumed", updatedAt: Date.now() });
    for (let i = 0; i < 100 && !stack.log("openchamber").match(/\[session-goal(:diagnostic)?\] (progress check|ses_\S+ progress check unavailable)/); i++) await sleep(100);

    // The check got a verdict, and no model was spawned for it.
    expect(stack.frames().filter((f) => f.type === "print").map((f) => String(f.prompt).slice(0, 60))).toEqual([]);
    expect(stack.log("openchamber")).toContain("[session-goal:diagnostic] progress check");
    expect(stack.log("openchamber")).not.toContain("progress check unavailable");
    // omp carries the resumed goal.
    for (let i = 0; i < 80 && stack.frames().filter((f) => f.type === "goal" && f.op === "resume").length === resumesBefore; i++) await sleep(100);
    expect(stack.frames().filter((f) => f.type === "goal" && f.op === "resume").length).toBe(resumesBefore + 1);
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
    const now = Date.now();
    const goal = { id: "goal3", objective: "run the job", objectiveFile: false, status: "active", tokenBudget: null, tokensUsed: 0, turnsUsed: 0, blockedStreak: 0, note: "", statusReason: "", lastAccountedMessageID: "", createdAt: now, updatedAt: now };
    await fetch(`${stack.ui}/api/session/${id}?directory=${dir()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { openchamber: { goal } } }),
    });
    const record = async () => (await stack.http(`/session/${id}?directory=${dir()}`)).body?.data?.metadata?.openchamber?.goal;

    // The job is running in the background: the parent run is over, so the parent is idle and the goal still active.
    await page.getByText("job started").first().waitFor({ timeout: 30_000 });
    for (let i = 0; i < 40 && (await status(id)) !== "idle"; i++) await sleep(50);
    const gap: string[] = [];
    for (let i = 0; i < 8; i++) {
      gap.push(await status(id));
      await sleep(100);
    }
    expect(gap).toEqual(Array(8).fill("idle"));
    expect((await record())?.status).toBe("active");
    expect(await page.getByText("digested the result").first().isVisible()).toBe(false);

    // The job's result wakes the parent; it made progress, so omp continues the goal and the agent completes it.
    await page.getByText("goal reached").first().waitFor({ timeout: 30_000 });
    let settled: any;
    for (let i = 0; i < 40 && settled?.status !== "complete"; i++) {
      settled = await record();
      await sleep(250);
    }
    expect(settled?.status).toBe("complete");
    expect(settled?.statusReason).toBe("reported by agent");
    expect(await page.getByText("digested the result").first().isVisible()).toBe(true);
    expect(stack.frames().filter((f) => f.type === "prompt").map((f) => f.message).at(-1)).toBe("kickoff");
  });

  test("a goal armed with its message: the message is answered first, then omp continues the goal", async () => {
    stack.script([
      { when: "(#1)", steps: [{ text: "objective met" }, { goalComplete: true }] },
      { when: "build it", steps: [{ tool: "bash", args: { command: "make" }, result: "built" }, { text: "on it" }] },
    ]);
    await newSession(page);
    await send(page, "warm up");
    await page.getByText("Echo: warm up").waitFor();
    const id = await sessionId();

    // OpenChamber's armed send: the goal record is written, then the message carrying the objective follows at once.
    const now = Date.now();
    const goal = { id: "goal4", objective: "build it", objectiveFile: false, status: "active", tokenBudget: null, tokensUsed: 0, turnsUsed: 0, blockedStreak: 0, note: "", statusReason: "", lastAccountedMessageID: "", createdAt: now, updatedAt: now };
    const res = await fetch(`${stack.ui}/api/session/${id}?directory=${dir()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { openchamber: { goal } } }),
    });
    expect(res.ok).toBe(true);
    await send(page, "build it");

    await page.getByText("on it").first().waitFor({ timeout: 30_000 });
    await page.getByText("objective met").first().waitFor({ timeout: 30_000 });
    // omp got the message before the goal: the goal joined that run instead of starting one ahead of it.
    const frames = stack.frames();
    const promptAt = frames.findIndex((f) => f.type === "prompt" && String(f.message).includes("build it"));
    const goalAt = frames.findIndex((f) => f.type === "goal" && f.op === "create" && f.objective === "build it");
    expect(promptAt).toBeGreaterThanOrEqual(0);
    expect(goalAt).toBeGreaterThan(promptAt);
    // Past OpenChamber's 5 s "unanswered" check: the message has its reply.
    for (let i = 0; i < 40 && (await status(id)) !== "idle"; i++) await sleep(100);
    await sleep(6_000);
    expect(await page.getByText("OpenCode did not start a reply to this message.").count()).toBe(0);
  });
});
