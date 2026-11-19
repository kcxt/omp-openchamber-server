import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { OmpInstance } from "./omp";
import { startStack, type Stack } from "./stack";
import { openSession } from "./ui";

let stack: Stack;
const link = () => join(stack.home, "link");

beforeAll(async () => {
  stack = await startStack();
  symlinkSync(stack.project, link());
});
afterAll(() => stack.stop());

/** A session written the way a terminal omp writes it, then released. */
async function terminalSession(cwd: string, prompt: string): Promise<string> {
  const omp = await OmpInstance.start(stack, cwd);
  await omp.prompt(prompt);
  const { sessionFile } = await omp.state();
  await omp.close();
  return sessionFile!;
}

const listed = async (directory: string) =>
  (await stack.http(`/session?directory=${encodeURIComponent(directory)}`)).body.data as Array<{ id: string; title: string }>;

describe("sessions written by a terminal omp show up in OpenChamber", () => {
  test("project under $HOME (bucket -proj)", async () => {
    await terminalSession(stack.project, "seeded under home");
    expect((await listed(stack.project)).map((s) => s.title)).toContain("seeded under home");
  });

  test("project outside $HOME (bucket --<abs>--)", async () => {
    const file = await terminalSession(stack.outside, "seeded outside home");
    expect(file).toMatch(/\/sessions\/--.+--\//);
    expect((await listed(stack.outside)).map((s) => s.title)).toContain("seeded outside home");
  });

  test("project reached through a symlink (OpenChamber stores the real path)", async () => {
    await terminalSession(link(), "seeded via symlink");
    expect((await listed(stack.project)).map((s) => s.title)).toContain("seeded via symlink");
  });

  test("the sidebar lists them and opening one renders its transcript", async () => {
    const page = await stack.page();
    await page.goto(stack.ui);
    await openSession(page, "seeded under home");
    await page.getByText("Echo: seeded under home").first().waitFor();
  });

  test("a session created from OpenChamber lands in omp's bucket for the project", async () => {
    const { body } = await stack.http(`/session?directory=${encodeURIComponent(stack.outside)}`, { json: { title: "made in ui" } });
    const created = body.data ?? body;
    expect(created.id).toBeTruthy();
    const file = stack.sessionFiles().find((f) => f.records.some((r) => r.type === "session" && r.cwd === stack.outside && r.title === "made in ui"));
    expect(file?.path).toMatch(/\/sessions\/--.+--\//);
  });
});
