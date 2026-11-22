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
const sessionId = async () => ((await stack.http(`/session?directory=${dir()}`)).body.data as Array<{ id: string }>)[0]!.id;
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

    // Armed the way OpenChamber does it: the goal record is written to the session metadata through its server.
    const now = Date.now();
    const goal = { id: "goal1", objective: "ship it", objectiveFile: false, status: "active", tokenBudget: null, tokensUsed: 0, turnsUsed: 0, blockedStreak: 0, note: "", statusReason: "", lastAccountedMessageID: "", createdAt: now, updatedAt: now };
    const res = await fetch(`${stack.ui}/api/session/${id}?directory=${dir()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { openchamber: { goal } } }),
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
});
