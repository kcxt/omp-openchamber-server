import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OmpInstance } from "./omp";
import { startStack, type Stack } from "./stack";
import { newSession, openSession, send, sessionMenu } from "./ui";

const TURNS = 40; // 80 messages: more than one page of OpenChamber's history loader

let stack: Stack;
let sessionId: string;

beforeAll(async () => {
  stack = await startStack();
  const omp = await OmpInstance.start(stack, stack.project);
  for (let i = 1; i <= TURNS; i++) await omp.prompt(`question number ${i}`);
  await omp.close();
  const list = (await stack.http(`/session?directory=${encodeURIComponent(stack.project)}`)).body.data;
  sessionId = list[0].id;
});
afterAll(() => stack.stop());

describe("session history", () => {
  test("paging the transcript newest-first visits every message exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const query = new URLSearchParams({ directory: stack.project, limit: "30", ...(cursor ? { cursor } : {}) });
      const { body } = await stack.http(`/session/${sessionId}/message?${query}`);
      seen.push(...body.data.map((m: any) => m.id));
      cursor = body.cursor?.next;
      if (!cursor) break;
    }
    expect(seen.length).toBe(TURNS * 2);
    expect(new Set(seen).size).toBe(TURNS * 2);
  });

  test("Export Markdown contains the whole conversation", async () => {
    const page = await stack.page();
    await page.goto(stack.ui);
    await openSession(page, "question number 1");
    await page.getByText(`Echo: question number ${TURNS}`).first().waitFor();

    const download = page.waitForEvent("download");
    await sessionMenu(page, "Export Markdown");
    const file = await (await download).path();
    const markdown = await Bun.file(file!).text();
    for (let i = 1; i <= TURNS; i++) {
      expect(markdown).toContain(`question number ${i}\n`);
      expect(markdown).toContain(`Echo: question number ${i}`);
    }
  });
});

describe("a conversation held in OpenChamber", () => {
  test("exports each message once, after live streaming and after a reload", async () => {
    stack.script([{ when: "use tools", steps: [{ thinking: "thinking it over" }, { text: "Running it. " }, { tool: "bash", args: { command: "echo hi" }, result: "hi" }, { text: "Ran it." }] }]);
    const page = await stack.page();
    await page.goto(stack.ui);
    await page.locator(".group\\/project").first().waitFor();
    await newSession(page);
    await send(page, "first message");
    await page.getByText("Echo: first message").waitFor();
    await send(page, "use tools please");
    await page.getByText("Ran it.").waitFor();
    await send(page, "third message");
    await page.getByText("Echo: third message").waitFor();

    const exportMarkdown = async () => {
      const download = page.waitForEvent("download");
      await sessionMenu(page, "Export Markdown");
      return Bun.file((await (await download).path())!).text();
    };
    const check = (markdown: string) => {
      for (const text of ["first message", "Echo: first message", "use tools please", "Running it.", "Ran it.", "third message", "Echo: third message"]) {
        expect(markdown.split("\n").filter((line) => line.trim() === text).length).toBe(1);
      }
    };
    check(await exportMarkdown());
    await page.reload();
    await page.getByText("Echo: third message").waitFor();
    check(await exportMarkdown());
  });
});

describe("a session that was branched in the terminal", () => {
  test("only the active branch is shown and exported", async () => {
    const omp = await OmpInstance.start(stack, stack.project);
    await omp.prompt("branch root");
    await omp.prompt("abandoned idea");
    const { entries } = await omp.request<{ entries: Array<{ id: string; type: string; message?: any }> }>("get_entries");
    const abandoned = entries.find((e) => e.type === "message" && e.message.role === "user" && e.message.content[0].text === "abandoned idea")!;
    await omp.request("navigate_tree", { entryId: abandoned.id }); // /tree: rewind past that message
    await omp.prompt("better idea");
    await omp.close();

    const list = (await stack.http(`/session?directory=${encodeURIComponent(stack.project)}`)).body.data as Array<{ id: string; title: string }>;
    const id = list.find((s) => s.title === "branch root")!.id;
    const { body } = await stack.http(`/session/${id}/message?directory=${encodeURIComponent(stack.project)}`);
    const text = JSON.stringify(body.data);
    expect(text).toContain("better idea");
    expect(text).not.toContain("abandoned idea");
    expect(body.data.length).toBe(4); // root, echo, better, echo
  });
});
