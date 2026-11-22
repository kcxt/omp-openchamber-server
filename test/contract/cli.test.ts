// P6 and the one-shot CLI the sidecar uses instead of a long-lived utility child (PLAN §3.11):
//   omp session inspect --json <path>    read-only open: never takes the lease, never writes
//   omp session lease --json -- <ids>    which sessions a running omp owns
//   omp models --json                    the model catalogue
// Runs against the stub and the real omp.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { must, Rig, writeFileSync, writeFixture, type Frame } from "./harness";

setDefaultTimeout(120_000);

const rig = new Rig();
const bare = new Rig({ noModels: true });
afterAll(async () => { await rig.close(); await bare.close(); });

const json = (stdout: string) => JSON.parse(stdout) as Frame;
const keys = (o: object) => Object.keys(o).sort();

/** A hand-written transcript with the given journal entries after the header. */
function writeSession(r: Rig, lines: Frame[], id = crypto.randomUUID()): { path: string; id: string } {
  const dir = join(r.agentDir, "sessions", "-proj");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-11-22T00-00-00-000Z_${id}.jsonl`);
  const title = { type: "title", v: 1, title: "", updatedAt: "2026-11-22T00:00:00.000Z", pad: "" };
  writeFileSync(path, [title, { type: "session", version: 3, id, timestamp: "2026-11-22T00:00:00.000Z", cwd: r.project }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { path, id };
}
const entry = (type: string, id: string, parentId: string | null, body: Frame) => ({ type, id, parentId, timestamp: "2026-11-22T00:00:01.000Z", ...body });

/** Everything an inspection must leave alone: every file under the agent dir and the lease directory, with size and mtime. */
function snapshot(r: Rig): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (!p.endsWith(".log") && !p.includes(`${join("agent", "agent.db")}`) && !p.includes("/sessions-meta")) out[p] = `${st.size}:${st.mtimeMs}`;
    }
  };
  walk(join(r.agentDir, "sessions"));
  walk(join(r.root, "run"));
  return out;
}

describe(`P6 omp models --json (${rig.kind})`, () => {
  test("lists the configured models with the catalogue fields", async () => {
    const r = await rig.cli(["models", "--json"]);
    expect(r.code).toBe(0);
    const { models } = json(r.stdout) as { models: Frame[] };
    expect(models.map((m) => m.selector)).toEqual(["fake/fast", "fake/smart"]);
    for (const m of models) {
      expect(keys(m)).toEqual(["contextWindow", "cost", "id", "input", "kind", "maxTokens", "name", "pricingStatus", "provider", "reasoning", "selector", "thinking"]);
      expect(m.kind).toBe("chat");
      expect(m.provider).toBe("fake");
      expect(m.contextWindow).toBe(100000);
      expect(m.maxTokens).toBe(8000);
      expect(keys(m.cost)).toEqual(["cacheRead", "cacheWrite", "input", "output"]);
    }
    expect(models[0]).toMatchObject({ name: "Stub Fast", reasoning: false, thinking: null, input: ["text"] });
    expect(models[1]).toMatchObject({ name: "Stub Smart", reasoning: true, input: ["text"] });
    expect(models[1]!.thinking).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });

  test("no configured provider: an empty list, not an error", async () => {
    const r = await bare.cli(["models", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r.stdout)).toEqual({ models: [] });
  });
});

describe(`P6 omp session lease (${rig.kind})`, () => {
  test("reports held sessions without taking any lease", async () => {
    const fx = writeFixture(rig);
    const none = await rig.cli(["session", "lease", "--json", "--", fx.id, "00000000-0000-0000-0000-000000000000"]);
    expect(none.code).toBe(0);
    expect(json(none.stdout)).toEqual({ held: [], unknown: [] });

    const owner = await rig.spawn();
    await owner.send({ type: "switch_session", sessionPath: fx.path, claimLease: true });
    const before = snapshot(rig);
    const held = await rig.cli(["session", "lease", "--json", "--", fx.id, "00000000-0000-0000-0000-000000000000"]);
    expect(json(held.stdout)).toEqual({ held: [fx.id], unknown: [] });
    // probing again and again never makes the prober an owner
    await rig.cli(["session", "lease", "--json", "--", fx.id]);
    expect(snapshot(rig)).toEqual(before);

    await owner.crash();
    const freed = await rig.cli(["session", "lease", "--json", "--", fx.id]);
    expect(json(freed.stdout)).toEqual({ held: [], unknown: [] });
  });

  test("ids starting with a dash survive `--`; no id is a usage error", async () => {
    const dashed = await rig.cli(["session", "lease", "--json", "--", "-not-a-flag"]);
    expect(dashed.code).toBe(0);
    expect(json(dashed.stdout)).toEqual({ held: [], unknown: [] });
    const missing = await rig.cli(["session", "lease", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("Missing session id");
  });
});

describe(`P6 omp session inspect (${rig.kind})`, () => {
  test("prints what a live session would report, with the exact shape", async () => {
    const fx = writeFixture(rig);
    const r = await rig.cli(["session", "inspect", "--json", fx.path]);
    expect(r.code).toBe(0);
    const out = json(r.stdout);
    expect(keys(out)).toEqual(["availableCommands", "contextBreakdown", "goal", "leaseHeld", "model", "sessionId", "thinkingLevel", "title", "todoPhases"]);
    expect(out.sessionId).toBe(fx.id);
    expect(out.title).toBeNull();
    expect(out.model).toEqual({ provider: "fake", modelId: "fast" });
    expect(out.thinkingLevel).toBeNull(); // a model without reasoning has no level
    expect(out.goal).toBeNull();
    expect(out.todoPhases).toEqual([]);
    expect(out.leaseHeld).toBe(false);
    expect(Array.isArray(out.availableCommands)).toBe(true);
    expect(out.availableCommands.length).toBeGreaterThan(0);
    for (const cmd of out.availableCommands) {
      expect(typeof cmd.name).toBe("string");
      expect(typeof cmd.description).toBe("string");
    }
    const b = out.contextBreakdown as Frame;
    expect(keys(b)).toEqual(["autoCompactBufferTokens", "categories", "contextWindow", "freeTokens", "model", "thresholdTokens", "usedTokens"]);
    expect(b.model).toEqual({ provider: "fake", modelId: "fast" });
    expect(b.contextWindow).toBe(100000);
    expect(b.categories.map((c: Frame) => c.id)).toEqual(["systemPrompt", "systemTools", "systemContext", "instructionFiles", "skills", "messages"]);
    for (const c of b.categories) expect(keys(c)).toEqual(["id", "label", "tokens"]);
    expect(b.freeTokens).toBeLessThan(b.contextWindow);
    expect(b.thresholdTokens).toBe(b.contextWindow - b.autoCompactBufferTokens);
  });

  test("the same session by id gives the same answer", async () => {
    const fx = writeFixture(rig);
    const byPath = json((await rig.cli(["session", "inspect", "--json", fx.path])).stdout);
    const byId = await rig.cli(["session", "inspect", "--json", fx.id]);
    expect(byId.code).toBe(0);
    expect(json(byId.stdout).sessionId).toBe(byPath.sessionId);
  });

  test("the context breakdown categories are the ones a live session reports", async () => {
    const fx = writeFixture(rig);
    const inspected = json((await rig.cli(["session", "inspect", "--json", fx.path])).stdout);
    const live = await rig.spawn();
    await live.send({ type: "switch_session", sessionPath: fx.path });
    const rpc = await live.ok<Frame>({ type: "get_context_breakdown" });
    const inspectedIds = inspected.contextBreakdown.categories.map((c: Frame) => c.id);
    const rpcIds = rpc.categories.map((c: Frame) => c.id);
    // omp: the same six categories and the same view. The stub's RPC answer keeps the two-category shape test/e2e/context.test.ts asserts.
    if (rig.kind === "real") {
      expect(rpcIds).toEqual(inspectedIds);
      expect(keys(rpc)).toEqual(keys(inspected.contextBreakdown));
    } else {
      for (const id of rpcIds) expect(inspectedIds).toContain(id);
    }
    const commands = await live.ok<{ commands: Frame[] }>({ type: "get_available_commands" });
    expect(commands.commands.map((c) => c.name).sort()).toEqual(inspected.availableCommands.map((c: Frame) => c.name).sort());
  });

  test("model and effort come from the journal", async () => {
    const smart = writeSession(rig, [
      entry("model_change", "a1b2c3d4", null, { model: "fake/smart", role: "default" }),
      entry("thinking_level_change", "b2c3d4e5", "a1b2c3d4", { thinkingLevel: "low", configured: "low" }),
    ]);
    const a = json((await rig.cli(["session", "inspect", "--json", smart.path])).stdout);
    expect(a.model).toEqual({ provider: "fake", modelId: "smart" });
    expect(a.thinkingLevel).toBe("low");
    expect("modelFallback" in a).toBe(false);

    const fast = writeSession(rig, [
      entry("model_change", "a1b2c3d4", null, { model: "fake/fast", role: "default" }),
      entry("thinking_level_change", "b2c3d4e5", "a1b2c3d4", { thinkingLevel: "high", configured: "high" }),
    ]);
    const b = json((await rig.cli(["session", "inspect", "--json", fast.path])).stdout);
    expect(b.model).toEqual({ provider: "fake", modelId: "fast" });
    expect(b.thinkingLevel).toBeNull();
  });

  test("a saved model that cannot be restored falls back and says why (modelFallback)", async () => {
    const gone = writeSession(rig, [entry("model_change", "a1b2c3d4", null, { model: "fake/gone", role: "default" })]);
    const r = await rig.cli(["session", "inspect", "--json", gone.path]);
    expect(r.code).toBe(0);
    const out = json(r.stdout);
    expect(out.model).toEqual({ provider: "fake", modelId: "fast" });
    expect(out.modelFallback.requested).toBe("fake/gone");
    expect(out.modelFallback.reason).toBe("Could not restore model fake/gone. Using fake/fast");
    expect(out.contextBreakdown.model).toEqual({ provider: "fake", modelId: "fast" });
    expect("contextBreakdownReason" in out).toBe(false);
  });

  test("with no model available: model null, a reason instead of a breakdown", async () => {
    const withModel = writeSession(bare, [entry("model_change", "a1b2c3d4", null, { model: "fake/fast", role: "default" })]);
    const out = json((await bare.cli(["session", "inspect", "--json", withModel.path])).stdout);
    expect(out.model).toBeNull();
    expect(out.modelFallback.requested).toBe("fake/fast");
    expect(out.modelFallback.reason).toContain("Could not restore model fake/fast.");
    expect(out.modelFallback.reason).toContain("No default model selected.");
    expect(out.contextBreakdown).toBeNull();
    expect(out.contextBreakdownReason).toBe("no model is selected for this session");
    expect(out.availableCommands.length).toBeGreaterThan(0);

    const empty = writeSession(bare, []);
    const none = json((await bare.cli(["session", "inspect", "--json", empty.path])).stdout);
    expect(none.model).toBeNull();
    expect(none.modelFallback.requested).toBeNull();
    expect(none.modelFallback.reason).toStartWith("No default model selected.");
    expect(none.contextBreakdown).toBeNull();
  });

  test("while another omp owns the session: leaseHeld is true, and the inspection takes nothing and writes nothing", async () => {
    const fx = writeFixture(rig);
    const owner = await rig.spawn();
    await owner.send({ type: "switch_session", sessionPath: fx.path, claimLease: true });
    const bytes = readFileSync(fx.path, "utf8");
    const before = snapshot(rig);

    const r = await rig.cli(["session", "inspect", "--json", fx.path]);
    expect(r.code).toBe(0);
    expect(json(r.stdout).leaseHeld).toBe(true);
    expect(readFileSync(fx.path, "utf8")).toBe(bytes);
    expect(snapshot(rig)).toEqual(before); // no new transcript, no lease file, no touched mtime

    // the owner still owns it, and a rival claim is still refused
    expect(json((await rig.cli(["session", "lease", "--json", "--", fx.id])).stdout).held).toEqual([fx.id]);
    const rival = await rig.spawn();
    expect((await rival.send({ type: "switch_session", sessionPath: fx.path, claimLease: true })).code).toBe("session_busy");
  });

  test("on a free session it leaves the transcript and the lease directory exactly as they were", async () => {
    const fx = writeFixture(rig);
    const bytes = readFileSync(fx.path, "utf8");
    const before = snapshot(rig);
    for (let i = 0; i < 2; i++) expect((await rig.cli(["session", "inspect", "--json", fx.path])).code).toBe(0);
    expect(readFileSync(fx.path, "utf8")).toBe(bytes);
    expect(snapshot(rig)).toEqual(before);
    expect(json((await rig.cli(["session", "lease", "--json", "--", fx.id])).stdout).held).toEqual([]);
    // and a process can still claim it afterwards
    const c = await rig.spawn();
    expect((await c.send({ type: "switch_session", sessionPath: fx.path, claimLease: true })).success).toBe(true);
  });

  test("failures are a one-line stderr message and exit 1, with nothing on stdout", async () => {
    const junk = join(rig.root, "junk.jsonl");
    writeFileSync(junk, "hello\n");
    const cases: Array<{ args: string[]; stderr: string }> = [
      { args: ["session", "inspect", "--json", join(rig.root, "nope.jsonl")], stderr: "Session file not found:" },
      { args: ["session", "inspect", "--json", junk], stderr: "the session header is missing or malformed" },
      { args: ["session", "inspect", "--json", rig.project], stderr: "Directories cannot be read like files" },
      { args: ["session", "inspect", junk], stderr: "inspect only prints JSON" },
    ];
    for (const { args, stderr } of cases) {
      const r = await rig.cli(args);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(stderr);
    }
    expect(must(readFileSync(junk, "utf8"), "junk file")).toBe("hello\n");
  });
});
