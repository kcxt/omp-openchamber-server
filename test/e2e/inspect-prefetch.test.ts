import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpInstance } from "./omp";
import { startStack, type Stack } from "./stack";

// A wrapper around the stub that logs every one-shot `omp session inspect` and makes it slow, so the
// test can tell a memoised answer (no second spawn, no wait) from a fresh one.
const wrapperDir = mkdtempSync(join(tmpdir(), "omp-wrapper-"));
const wrapper = join(wrapperDir, "omp");
const log = join(wrapperDir, "calls.log");
const STUB = join(import.meta.dir, "..", "stub-omp", "omp");
writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = session ] && [ "$2" = inspect ]; then echo inspect >> "${log}"; sleep 1.5; fi\nexec "${STUB}" "$@"\n`);
chmodSync(wrapper, 0o755);

const inspections = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);

let stack: Stack;
beforeAll(async () => { stack = await startStack({ binary: wrapper }); });
afterAll(() => stack.stop());

const dir = () => encodeURIComponent(stack.project);

describe("context panel on an undriven session", () => {
  test("the first read prefetches omp's inspection, so the breakdown answers from the memo", async () => {
    const terminal = await OmpInstance.start(stack, stack.project);
    await terminal.prompt("seed for prefetch");
    await terminal.close();
    const id = ((await stack.http(`/session?directory=${dir()}`)).body.data as any[]).find((s) => s.title === "seed for prefetch").id;
    const before = inspections();

    // Opening the session is what starts the background inspection.
    expect(((await stack.http(`/session/${id}/message?directory=${dir()}`)).body.data as any[]).length).toBeGreaterThan(0);
    const start = Date.now();
    while (inspections() === before) {
      if (Date.now() - start > 10_000) throw new Error("no inspection was started by the first read");
      await Bun.sleep(25);
    }
    await Bun.sleep(2_500); // the prefetch (1.5 s) has finished

    const asked = Date.now();
    const { status, body } = await stack.http(`/api/omp/context/${id}?directory=${dir()}&breakdown=1`);
    expect(status).toBe(200);
    expect(body.breakdown?.categories?.map((c: any) => c.id)).toContain("systemPrompt");
    expect(Date.now() - asked).toBeLessThan(1_000);
    expect(inspections()).toBe(before + 1);
  });
});
