import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { startStack, type Stack } from "./stack";
import { newSession, pickModel, send } from "./ui";

let stack: Stack;
let page: Page;

beforeAll(async () => {
  stack = await startStack();
  page = await stack.page();
  await page.goto(stack.ui);
  await page.locator(".group\\/project").first().waitFor();
});
afterAll(() => stack.stop());

const sessions = async () =>
  (await stack.http(`/session?directory=${encodeURIComponent(stack.project)}`)).body.data as Array<{ id: string; title: string }>;
/** Assistant content blocks of the transcript OpenChamber fetches (v2 message shape). */
const blocks = async (id: string): Promise<any[]> =>
  ((await stack.http(`/session/${id}/message?directory=${encodeURIComponent(stack.project)}`)).body.data as any[]).flatMap((m) => m.content ?? []);

describe("a turn renders the way omp produced it", () => {
  test("text, reasoning, a tool call with its output, and the todo list", async () => {
    stack.script([{ when: "plan", steps: [
      { thinking: "I should list the files first" },
      { text: "Listing. " },
      { tool: "bash", args: { command: "ls -la" }, result: "total 0\nfile-a.txt" },
      { tool: "todo", args: { ops: [] }, result: "ok", details: { phases: [{ name: "Work", tasks: [
        { id: "t1", content: "Write the stub", status: "completed" },
        { id: "t2", content: "Run the tests", status: "in_progress" },
        { id: "t3", content: "Ship it", status: "pending" },
      ] }] } },
      { text: "All done." },
    ] }]);
    await newSession(page);
    await send(page, "plan please");
    await page.getByText("All done.").first().waitFor();

    // Tool card: command and output.
    await page.getByText("Bash", { exact: true }).first().click();
    await page.getByText("Command: ls -la").waitFor();
    await page.getByText("file-a.txt").waitFor();
    // Todo list in the side panel, with omp's statuses.
    await page.getByText("Run the tests", { exact: true }).waitFor();
    await page.getByText("Ship it", { exact: true }).waitFor();
    await page.getByText("1/3").waitFor();

    // The transcript OpenChamber re-fetches carries the same parts.
    const [{ id }] = await sessions();
    const content = await blocks(id);
    expect(content.some((c) => c.type === "reasoning" && c.text.includes("list the files"))).toBe(true);
    const bash = content.find((c) => c.type === "tool" && c.name === "bash");
    expect(bash?.state.status).toBe("completed");
    expect(bash?.state.input.command).toBe("ls -la");
    expect(JSON.stringify(bash?.state.content)).toContain("file-a.txt");
    const todos = (await stack.http(`/session/${id}/todo?directory=${encodeURIComponent(stack.project)}`)).body;
    expect((todos.data ?? todos).map((t: any) => t.status)).toEqual(["completed", "in_progress", "pending"]);
  });

  test("a reload shows the same conversation and todo list", async () => {
    await page.reload();
    await page.getByText("All done.").first().waitFor();
    await page.getByText("Run the tests", { exact: true }).waitFor();
  });
});

describe("model switching", () => {
  test("the picked model is applied to omp and recorded on the turn", async () => {
    await newSession(page);
    await pickModel(page, "Stub Fast", "Stub Smart");
    await send(page, "which model");
    await page.getByText("Echo: which model").waitFor();

    expect(stack.frames().some((f) => f.type === "set_model" && f.provider === "stub" && f.modelId === "smart")).toBe(true);
    const files = stack.sessionFiles().filter((f) => f.records.some((r) => r.message?.content?.[0]?.text === "which model"));
    const assistant = files[0]!.records.find((r) => r.message?.role === "assistant");
    expect(assistant?.message.model).toBe("smart");
    await page.getByText("Stub Smart").last().waitFor();
  });
});
