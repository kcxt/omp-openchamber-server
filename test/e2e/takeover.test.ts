import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OmpInstance } from "./omp";
import { startStack, type Stack } from "./stack";
import { composer, openSession, send } from "./ui";

let stack: Stack;

beforeAll(async () => {
  // OpenChamber's omp child lets go of a session this quickly once it is idle.
  stack = await startStack({ env: { OC_CHILD_IDLE_MS: "400" } });
});
afterAll(() => stack.stop());

const dir = () => encodeURIComponent(stack.project);
const listed = async () => (await stack.http(`/session?directory=${dir()}`)).body.data as Array<{ id: string; title: string; parentID?: string }>;
const userTexts = (records: Array<Record<string, any>>) =>
  records.filter((r) => r.type === "message" && r.message.role === "user").map((r) => r.message.content[0].text);
const header = (records: Array<Record<string, any>>) => records.find((r) => r.type === "session")!;
const fileOf = (marker: string) => stack.sessionFiles().filter((f) => userTexts(f.records).includes(marker));

describe("the terminal still has the session open", () => {
  test("OpenChamber refuses to send, so nothing is forked by accident", async () => {
    const terminal = await OmpInstance.start(stack, stack.project);
    await terminal.prompt("from the terminal");
    const original = (await terminal.state()).sessionFile!;

    const page = await stack.page();
    await page.goto(stack.ui);
    await openSession(page, "from the terminal");
    await send(page, "from openchamber");
    // The refusal reaches the user as a toast.
    await page.getByText(/open in another omp/).first().waitFor();

    // The API says the same, and no sibling transcript appeared.
    const id = (await listed()).find((s) => s.title === "from the terminal")!.id;
    const direct = await stack.http(`/session/${id}/prompt_async?directory=${dir()}`, { json: { parts: [{ type: "text", text: "again" }] } });
    expect(direct.status).toBe(400);
    expect(JSON.stringify(direct.body)).toContain("another omp");
    expect(stack.sessionFiles().filter((f) => f.path !== original && userTexts(f.records).includes("from the terminal"))).toEqual([]);

    // Once the terminal lets go, the very same session continues in place.
    await terminal.close();
    await composer(page).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("from openchamber, later");
    await page.keyboard.press("Enter");
    await page.getByText("Echo: from openchamber, later").waitFor();
    expect(userTexts(fileOf("from openchamber, later")[0]!.records)).toEqual(["from the terminal", "from openchamber, later"]);
    expect(fileOf("from openchamber, later").map((f) => f.path)).toEqual([original]);
  });
});

describe("handing a session back and forth", () => {
  test("once OpenChamber is idle the terminal resumes the very same session", async () => {
    const page = await stack.page();
    await page.goto(stack.ui);
    await page.locator(".group\\/project").first().waitFor();
    const seed = await OmpInstance.start(stack, stack.project);
    await seed.prompt("handoff start");
    const file = (await seed.state()).sessionFile!;
    await seed.close();

    await openSession(page, "handoff start");
    await send(page, "handoff via openchamber");
    await page.getByText("Echo: handoff via openchamber").waitFor();
    await Bun.sleep(1200); // OpenChamber's child is idle and has released the session

    const terminal = await OmpInstance.start(stack, stack.project);
    await terminal.resume(file);
    await terminal.prompt("handoff back in terminal");
    await terminal.close();

    // Same file, three turns: nothing was forked.
    expect(fileOf("handoff back in terminal").map((f) => f.path)).toEqual([file]);
    expect(userTexts(fileOf("handoff start")[0]!.records)).toEqual(["handoff start", "handoff via openchamber", "handoff back in terminal"]);
    await page.reload();
    await page.getByText("Echo: handoff back in terminal").waitFor();
  });
});

describe("forks made by omp are ordinary sessions in OpenChamber", () => {
  test("a /fork of a session is listed next to it, not hidden as a child", async () => {
    const terminal = await OmpInstance.start(stack, stack.project);
    await terminal.prompt("lineage root");
    await terminal.request("fork");
    await terminal.prompt("lineage branch");
    await terminal.close();
    // The fork carries the whole history, so both are listed under that title, both top-level.
    const roots = (await listed()).filter((s) => s.title === "lineage root");
    expect(roots.length).toBe(2);
    expect(roots.every((s) => s.parentID === undefined)).toBe(true);
    expect(fileOf("lineage branch").length).toBe(1);
  });
});
