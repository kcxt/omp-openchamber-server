// Contract-test harness: runs `omp --mode rpc` (the real worktree build or test/stub-omp/omp) as a
// child under a hermetic environment (PLAN.md §8):
//   - env -i semantics: the child gets exactly PATH, the throwaway HOME/PI_CODING_AGENT_DIR/XDG_*/TMPDIR
//     and a few PI_*/OMP_STUB_* test flags; never process.env, so API keys and tokens cannot leak in;
//   - models.yml in the throwaway agent dir declares ONE provider, `fake`, an openai-completions endpoint
//     on 127.0.0.1 (test/contract/fake-provider.ts) with apiKey `dummy`;
//   - startup asserts get_available_models lists only fake/* and aborts the child otherwise.
//
//   CONTRACT_OMP=stub (default)  test/stub-omp/omp
//   CONTRACT_OMP=real            bun --preload ./packages/coding-agent/scripts/omp.ts packages/coding-agent/src/cli.ts
//                                from CONTRACT_OMP_DIR (default /hdd/brute/projects/oh-my-pi-local)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FakeProvider, type Script } from "./fake-provider";

export type Frame = Record<string, any>;
export type OmpKind = "real" | "stub";

export const kind: OmpKind = process.env.CONTRACT_OMP === "real" ? "real" : "stub";
export const isReal = kind === "real";
const REPO = resolve(import.meta.dir, "..", "..");
const STUB = join(REPO, "test", "stub-omp", "omp");
const OMP_DIR = process.env.CONTRACT_OMP_DIR ?? "/hdd/brute/projects/oh-my-pi-local";
/** Everything a contract run creates lives under here, never under the real $HOME. */
const TMP_BASE = process.env.CONTRACT_TMP ?? (existsSync("/hdd/brute/tmp") ? "/hdd/brute/tmp" : tmpdir());

export const MODELS = ["fast", "smart"] as const;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One throwaway world: directories, a fake model server, and the children started in it. */
export class Rig {
  readonly root = mkdtempSync(join(TMP_BASE, "omp-contract-"));
  readonly home = join(this.root, "home");
  readonly agentDir = join(this.home, ".omp", "agent");
  readonly tmp = join(this.root, "tmp");
  readonly project = join(this.home, "proj");
  readonly fake = new FakeProvider().start();
  readonly children: OmpChild[] = [];
  readonly kind = kind;

  constructor() {
    for (const dir of [this.agentDir, this.tmp, this.project, join(this.home, ".config"), join(this.home, ".local", "state"), join(this.home, ".local", "share")]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
      join(this.agentDir, "models.yml"),
      [
        "providers:",
        "  fake:",
        `    baseUrl: ${this.fake.baseUrl}`,
        "    apiKey: dummy",
        "    api: openai-completions",
        "    models:",
        "      - id: fast",
        "        name: Stub Fast",
        "        reasoning: false",
        "        input: [text]",
        "        contextWindow: 100000",
        "        maxTokens: 8000",
        "      - id: smart",
        "        name: Stub Smart",
        "        reasoning: true",
        "        input: [text]",
        "        contextWindow: 100000",
        "        maxTokens: 8000",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(this.agentDir, "config.yml"),
      ["autoResume: false", "mcp:", "  enableProjectConfig: false", "browser:", "  enabled: false", "  relay: false", ""].join("\n"),
    );
  }

  /** Same script drives the stub (script file) and the real omp (fake provider). */
  setScript(script: Script): void {
    this.fake.script = script;
    writeFileSync(join(this.root, "script.json"), JSON.stringify(script));
  }

  /** The exact environment a child gets. */
  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: this.home,
      PI_CODING_AGENT_DIR: this.agentDir,
      XDG_CONFIG_HOME: join(this.home, ".config"),
      XDG_STATE_HOME: join(this.home, ".local", "state"),
      XDG_DATA_HOME: join(this.home, ".local", "share"),
      TMPDIR: this.tmp,
      PI_SKIP_VERSION_CHECK: "1",
      OMP_STUB_SCRIPT: join(this.root, "script.json"),
      OMP_STUB_PROVIDER: "fake",
      OMP_STUB_PROVIDER_PORT: String(this.fake.port),
      PI_TEST_SESSION_OWNERS_DIR: join(this.root, "run", "session-owners"),
      ...extra,
    };
  }

  /** Start a child, wait for it to answer, and verify it can only reach fake/* models. */
  async spawn(opts: { cwd?: string; args?: string[]; env?: Record<string, string> } = {}): Promise<OmpChild> {
    const cwd = opts.cwd ?? this.project;
    const child = OmpChild.start(this, cwd, opts.args ?? [], opts.env ?? {});
    this.children.push(child);
    try {
      await child.assertOnlyFakeModels();
    } catch (error) {
      await child.stop();
      throw error;
    }
    return child;
  }

  async close(): Promise<void> {
    await Promise.all(this.children.map((c) => c.stop()));
    this.fake.stop();
    rmSync(this.root, { recursive: true, force: true });
  }

  /** Session transcripts under the agent dir, newest first. */
  transcripts(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".jsonl")) files.push(p);
      }
    };
    walk(join(this.agentDir, "sessions"));
    return files.sort().reverse();
  }
}

export class OmpChild {
  readonly frames: Frame[] = [];
  readonly stderrLog: string[] = [];
  #proc: ReturnType<typeof Bun.spawn>;
  #pending = new Map<string, (f: Frame) => void>();
  #waiters: Array<{ from: number; match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  #next = 1;
  exited = false;

  private constructor(proc: ReturnType<typeof Bun.spawn>) {
    this.#proc = proc;
    void this.#pump(proc.stdout as ReadableStream<Uint8Array>);
    void this.#drain(proc.stderr as ReadableStream<Uint8Array>);
    void proc.exited.then(() => { this.exited = true; });
  }

  static start(rig: Rig, cwd: string, args: string[], env: Record<string, string>): OmpChild {
    const common = ["--mode", "rpc", "--cwd", cwd, "--no-title", "--no-pty", ...args];
    const cmd = kind === "real"
      ? ["bun", "--preload", "./packages/coding-agent/scripts/omp.ts", "packages/coding-agent/src/cli.ts", ...common]
      : [STUB, ...common];
    const proc = Bun.spawn(cmd, {
      cwd: kind === "real" ? OMP_DIR : REPO,
      env: rig.env(env), // allow-list only: Bun.spawn replaces the environment, it never inherits it
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    return new OmpChild(proc);
  }

  get pid(): number {
    return this.#proc.pid;
  }

  async #pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let frame: Frame;
        try { frame = JSON.parse(line); } catch { continue; }
        this.#deliver(frame);
      }
    }
  }

  async #drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) this.stderrLog.push(decoder.decode(chunk));
  }

  #deliver(frame: Frame): void {
    this.frames.push(frame);
    const index = this.frames.length - 1;
    if (frame.type === "response" && typeof frame.id === "string") this.#pending.get(frame.id)?.(frame);
    for (let i = this.#waiters.length - 1; i >= 0; i--) {
      const w = this.#waiters[i]!;
      if (index >= w.from && w.match(frame)) {
        this.#waiters.splice(i, 1);
        w.resolve(frame);
      }
    }
  }

  /** Write a command without waiting; returns its id. */
  fire(command: Record<string, unknown>): string {
    const id = `c${this.#next++}`;
    (this.#proc.stdin as { write(d: string): number; flush?: () => void }).write(`${JSON.stringify({ id, ...command })}\n`);
    (this.#proc.stdin as { flush?: () => void }).flush?.();
    return id;
  }

  /** Send a command and return its response frame, success or not. */
  async send(command: Record<string, unknown>, timeoutMs = 30_000): Promise<Frame> {
    const id = `c${this.#next}`;
    const response = new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for response to ${JSON.stringify(command).slice(0, 120)}\n${this.stderrTail()}`)), timeoutMs);
      this.#pending.set(id, (f) => { clearTimeout(timer); resolve(f); });
    });
    this.fire(command);
    const frame = await response;
    this.#pending.delete(id);
    return frame;
  }

  /** `send`, but a failure response throws; returns `data`. */
  async ok<T = any>(command: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const r = await this.send(command, timeoutMs);
    if (!r.success) throw new Error(`${String(command.type)} failed: ${r.error} (${r.code ?? "no code"})`);
    return r.data as T;
  }

  /** Index to pass as `from` so later waits only see frames written after now. */
  mark(): number {
    return this.frames.length;
  }

  waitFor(match: (f: Frame) => boolean, opts: { from?: number; timeoutMs?: number; label?: string } = {}): Promise<Frame> {
    const from = opts.from ?? 0;
    for (let i = from; i < this.frames.length; i++) if (match(this.frames[i]!)) return Promise.resolve(this.frames[i]!);
    return new Promise<Frame>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        const idx = this.#waiters.findIndex((w) => w.resolve === done);
        if (idx >= 0) this.#waiters.splice(idx, 1);
        reject(new Error(`timeout waiting for ${opts.label ?? "frame"}; frames since: ${this.shape(from).join(" ")}\n${this.stderrTail()}`));
      }, timeoutMs);
      const done = (f: Frame) => { clearTimeout(timer); resolve(f); };
      this.#waiters.push({ from, match, resolve: done });
    });
  }

  waitType(type: string, opts: { from?: number; timeoutMs?: number } = {}): Promise<Frame> {
    return this.waitFor((f) => f.type === type, { ...opts, label: type });
  }

  /** Wait for the stretch to close: `session_settled`, or `prompt_result{sessionSettled:true}` with no stretch left open. */
  settled(from: number, timeoutMs = 30_000): Promise<Frame> {
    return this.waitType("session_settled", { from, timeoutMs });
  }

  /** Frames since `from`, as stable labels (streaming deltas and noise dropped). */
  shape(from = 0, to = this.frames.length): string[] {
    return shapeOf(this.frames.slice(from, to));
  }

  stderrTail(): string {
    return `--- stderr tail ---\n${this.stderrLog.join("").split("\n").slice(-15).join("\n")}`;
  }

  async assertOnlyFakeModels(): Promise<void> {
    const data = await this.ok<{ models?: Array<{ provider: string; id: string }> } | Array<{ provider: string; id: string }>>({ type: "get_available_models" }, 90_000);
    const models = Array.isArray(data) ? data : (data.models ?? []);
    const foreign = models.filter((m) => m.provider !== "fake");
    if (models.length === 0 || foreign.length > 0) {
      throw new Error(`credential isolation violated: get_available_models must list only fake/*, got ${models.map((m) => `${m.provider}/${m.id}`).join(", ") || "(none)"}`);
    }
    const state = await this.ok<{ model?: { provider?: string } }>({ type: "get_state" });
    if (state.model?.provider && state.model.provider !== "fake") throw new Error(`credential isolation violated: active model is ${state.model.provider}`);
    console.log(`[contract:${kind}] get_available_models -> ${models.map((m) => `${m.provider}/${m.id}`).join(", ")}`);
  }

  /** Close stdin, then terminate the whole process group. */
  async stop(): Promise<void> {
    if (!this.exited) {
      try { (this.#proc.stdin as { end(): void }).end(); } catch { /* closed */ }
      await Promise.race([this.#proc.exited, sleep(3000)]);
    }
    if (!this.exited) {
      try { process.kill(-this.#proc.pid, "SIGKILL"); } catch { /* gone */ }
      await Promise.race([this.#proc.exited, sleep(2000)]);
    }
  }

  /** SIGKILL the process group now (a crash, not a shutdown). */
  async crash(): Promise<void> {
    try { process.kill(-this.#proc.pid, "SIGKILL"); } catch { /* gone */ }
    await Promise.race([this.#proc.exited, sleep(2000)]);
  }
}

const NOISE = new Set(["ready", "message_update", "tool_execution_update", "available_commands_update", "config_update", "session_info_update", "notice", "extension_ui_request", "todo_reminder"]);

export function labelOf(f: Frame): string | undefined {
  if (f.type === "response") return `response:${f.command}${f.success === false ? "!" : ""}`;
  if (NOISE.has(f.type)) return undefined;
  if (f.type === "message_start" || f.type === "message_end") return `${f.type}:${f.message?.role}`;
  if (f.type === "prompt_result") return `prompt_result{agentInvoked:${f.agentInvoked},status:${f.status},sessionSettled:${f.sessionSettled}}`;
  if (f.type === "tool_execution_start" || f.type === "tool_execution_end") return `${f.type}`;
  return f.type;
}

export function shapeOf(frames: Frame[]): string[] {
  const out: string[] = [];
  for (const f of frames) {
    const l = labelOf(f);
    if (l) out.push(l);
  }
  return out;
}

/** Transcript lines (JSON) of a session file, minus the title slot. */
export function readTranscript(path: string): Frame[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function tree(path: string): { header: Frame; entries: Frame[] } {
  const lines = readTranscript(path);
  return { header: lines.find((l) => l.type === "session")!, entries: lines.filter((l) => l.type !== "session" && l.type !== "title" && typeof l.id === "string") };
}

/** Narrow a lookup that must succeed: fails the test with `what` instead of a TypeError later. */
export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to exist`);
  return value;
}

export function ensureDir(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
}

export { writeFileSync, existsSync };

export interface Fixture {
  path: string;
  id: string;
  /** Entry ids in append order: u1 a1 u2 a2 u3 a3. */
  ids: { u1: string; a1: string; u2: string; a2: string; u3: string; a3: string };
}

/** A hand-written omp v3 transcript: three user/assistant exchanges on one branch, no model needed. */
export function writeFixture(rig: Rig, cwd = rig.project, bucket = "-proj", padChars = 0): Fixture {
  const id = crypto.randomUUID();
  const stamp = new Date().toISOString();
  const path = join(rig.agentDir, "sessions", bucket, `${stamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const hex = () => crypto.randomUUID().slice(0, 8);
  const ids = { u1: hex(), a1: hex(), u2: hex(), a2: hex(), u3: hex(), a3: hex() };
  const order = ["u1", "a1", "u2", "a2", "u3", "a3"] as const;
  let t = Date.now() - 60_000;
  const lines: string[] = [];
  const title = { type: "title", v: 1, title: "", updatedAt: stamp, pad: "" };
  const used = Buffer.byteLength(JSON.stringify(title)) + 1;
  lines.push(JSON.stringify({ ...title, pad: " ".repeat(Math.max(0, 256 - used)) }));
  lines.push(JSON.stringify({ type: "session", version: 3, id, timestamp: stamp, cwd }));
  order.forEach((key, i) => {
    const user = key.startsWith("u");
    const n = key.slice(1);
    t += 1000;
    const message = user
      ? { role: "user", content: [{ type: "text", text: `question ${n}${"x ".repeat(padChars / 2)}` }], attribution: "user", timestamp: t }
      : {
          role: "assistant", content: [{ type: "text", text: `answer ${n}${"y ".repeat(padChars / 2)}` }], api: "openai-completions", provider: "fake", model: "fast",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", timestamp: t,
        };
    lines.push(JSON.stringify({ type: "message", id: ids[key], parentId: i === 0 ? null : ids[order[i - 1]!], timestamp: new Date(t).toISOString(), message }));
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
  return { path, id, ids };
}
