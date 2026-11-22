// `--auto-title`: an RPC omp names its session from the first message, as the interactive mode does (RPC hosts
// opt in; `--mode rpc` alone never titles). The title lands in the transcript's title slot and, with the patched
// omp, is announced by `session_info_update {title, sessionId}` (every title change, not only a command's). Runs
// against the stub and the real omp; the real omp's title request goes to the fake provider (the script's `title`).
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
  test("a first prompt leads to a title in the transcript's title slot, announced by session_info_update", async () => {
    rig.setScript({ turns: [], title: "Scripted session title" });
    const c = await rig.spawn({ args: ["--auto-title"] });
    const m = c.mark();
    const file = await firstRun(c, "please fix the broken build");
    // The title lands after the run, from a side request: the frame is the only signal a host gets.
    const info = await c.waitFor((f) => f.type === "session_info_update" && typeof f.title === "string" && f.title.length > 0, { from: m, label: "session_info_update with a title" });
    expect(info.title).toBe("Scripted session title");
    expect(slotOf(file)?.title).toBe("Scripted session title");
  });

  test("without the flag an RPC session is never titled", async () => {
    rig.setScript({ turns: [], title: "Never written" });
    const c = await rig.spawn();
    const file = await firstRun(c, "please fix the broken build");
    await sleep(1_500);
    expect(slotOf(file)?.title ?? "").toBe("");
  });
});
