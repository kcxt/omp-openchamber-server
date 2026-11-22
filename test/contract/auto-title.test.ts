// `--auto-title`: an RPC omp names its session from the first message, as the interactive mode does (RPC hosts
// opt in; `--mode rpc` alone never titles). omp emits NO event when it does: the title lands in the transcript's
// title slot (first line), which is where the sidecar reads it. Runs against the stub and the real omp; the real
// omp's title request goes to the fake provider, which answers it with the script's `title`.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readTranscript, Rig, sleep, type OmpChild } from "./harness";

setDefaultTimeout(90_000);

const rig = new Rig();
afterAll(() => rig.close());

const slotOf = (path: string): { title?: string } | undefined => {
  try {
    const first = readTranscript(path)[0];
    return first?.type === "title" ? first : undefined;
  } catch {
    return undefined;
  }
};

async function firstRun(c: OmpChild, message: string): Promise<string> {
  const m = c.mark();
  await c.send({ type: "prompt", message });
  await c.settled(m);
  return (await c.ok({ type: "get_state" })).sessionFile as string;
}

describe(`--auto-title (${rig.kind})`, () => {
  test("a first prompt leads to a non-empty title in the transcript's title slot, announced by no frame", async () => {
    rig.setScript({ turns: [], title: "Scripted session title" });
    const c = await rig.spawn({ args: ["--auto-title"] });
    const m = c.mark();
    const file = await firstRun(c, "please fix the broken build");
    const start = Date.now();
    while (!slotOf(file)?.title && Date.now() - start < 30_000) await sleep(100);
    expect(slotOf(file)?.title).toBe("Scripted session title");
    // No frame says the title changed: a host has to read the slot.
    expect(c.frames.slice(m).some((f) => /title|renamed/i.test(String(f.type)))).toBe(false);
  });

  test("without the flag an RPC session is never titled", async () => {
    rig.setScript({ turns: [], title: "Never written" });
    const c = await rig.spawn();
    const file = await firstRun(c, "please fix the broken build");
    await sleep(1_500);
    expect(slotOf(file)?.title ?? "").toBe("");
  });
});
