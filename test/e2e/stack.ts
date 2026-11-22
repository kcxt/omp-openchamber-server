// Offline end-to-end stack: stub omp <- sidecar <- `openchamber serve` <- headless Chromium.
//
// Everything lives under one throwaway root. HOME, XDG_*, PI_CODING_AGENT_DIR, TMPDIR and
// OPENCHAMBER_DATA_DIR all point into it, and the children get an explicit environment (no
// inherited API keys, no ~/.omp), so a run can neither read nor write the user's real state.
import { setDefaultTimeout } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Browser steps are slow next to unit tests.
setDefaultTimeout(90_000);

const REPO = join(import.meta.dir, "..", "..");
const STUB = join(REPO, "test", "stub-omp", "omp");
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";

export type Step =
  | { text: string }
  | { thinking: string }
  | { sleep: number }
  | { hang: true }
  | { fail: string }
  | { crash: true }
  | { goalComplete: true }
  | { tool: string; args?: Record<string, unknown>; result?: string; isError?: boolean; details?: unknown; sleep?: number; asyncMs?: number };
export type Turn = { when?: string; steps: Step[] };

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port!;
  await server.stop(true);
  return port;
}

async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await probe().catch(() => false)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

export async function startStack(options: { env?: Record<string, string>; binary?: string } = {}) {
  // Outside the repo: OpenChamber lists the git worktrees of any checkout it finds above a project.
  const root = mkdtempSync(join(tmpdir(), "omp-e2e-"));
  const home = join(root, "home");
  const agentDir = join(home, ".omp", "agent");
  const tmp = join(root, "tmp");
  const ocData = join(root, "openchamber");
  const project = join(home, "proj"); // under HOME  -> omp bucket `-proj`
  const outside = join(root, "outside", "proj"); // outside HOME and TMPDIR -> bucket `--<abs>--`
  for (const dir of [project, outside, tmp, ocData, agentDir, join(home, ".config")]) mkdirSync(dir, { recursive: true });

  const scriptFile = join(root, "script.json");
  const recordFile = join(root, "frames.jsonl");
  const logs = join(root, "logs");
  mkdirSync(logs);
  writeFileSync(scriptFile, JSON.stringify({ turns: [] }));

  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PI_CODING_AGENT_DIR: agentDir,
    OPENCHAMBER_DATA_DIR: ocData,
    OMP_STUB_SCRIPT: scriptFile,
    OMP_STUB_RECORD: recordFile,
    ...options.env,
  };

  writeFileSync(join(ocData, "settings.json"), JSON.stringify({
    projects: [
      { id: "proj", path: project, label: "proj", addedAt: Date.now(), lastOpenedAt: Date.now() },
      { id: "outside", path: outside, label: "outside", addedAt: Date.now() - 1 },
    ],
    activeProjectId: "proj",
    // Keep the first-run chrome (what's-new, tips, update prompts) out of the way.
    lastSeenVersion: "999.0.0",
  }));

  const sidecarPort = await freePort();
  const uiPort = await freePort();

  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  const spawn = (name: string, cmd: string[], env: Record<string, string>) => {
    const log = Bun.file(join(logs, `${name}.log`));
    const proc = Bun.spawn(cmd, { cwd: REPO, env, stdout: log, stderr: log, stdin: "ignore" });
    children.push(proc);
    return proc;
  };

  let sidecar = startSidecar();
  function startSidecar() {
    return spawn("sidecar", ["bun", "src/main.ts", "--binary", options.binary ?? STUB, "--port", String(sidecarPort)], {
      ...baseEnv,
      OC_SIDECAR_PORT: String(sidecarPort),
      OC_SIDECAR_HOST: "127.0.0.1",
    });
  }
  const api = `http://127.0.0.1:${sidecarPort}`;
  await waitFor("sidecar", async () => (await fetch(`${api}/health`)).ok);

  spawn("openchamber", ["openchamber", "serve", "--foreground", "--port", String(uiPort), "--host", "127.0.0.1"], {
    ...baseEnv,
    OPENCODE_HOST: api,
    OPENCODE_SKIP_START: "true",
    OPENCODE_BINARY: join(REPO, "bin", "opencode-unused"),
  });
  const ui = `http://127.0.0.1:${uiPort}`;
  await waitFor("openchamber", async () => (await fetch(`${ui}/health`)).ok, 60_000);

  // Launched on first page(): API-only tests need no browser.
  let browser: Browser | undefined;

  const stack = {
    root, home, agentDir, project, outside, api, ui, logs,
    sessionsDir: join(agentDir, "sessions"),
    stubBin: STUB,
    env: baseEnv,

    /** Replace the stub's script; takes effect on the next prompt. */
    script(turns: Turn[]): void {
      writeFileSync(scriptFile, JSON.stringify({ turns }));
    },
    /** Frames the sidecar sent to any stub omp, in order. */
    frames(): Array<Record<string, any>> {
      if (!existsSync(recordFile)) return [];
      return readFileSync(recordFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    /** Every session JSONL the stub (or a test) wrote, as {path, records}. */
    sessionFiles(): Array<{ path: string; records: Array<Record<string, any>> }> {
      const found: Array<{ path: string; records: Array<Record<string, any>> }> = [];
      const walk = (dir: string) => {
        for (const ent of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
          const p = join(dir, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (ent.name.endsWith(".jsonl")) {
            found.push({ path: p, records: readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) });
          }
        }
      };
      walk(join(agentDir, "sessions"));
      return found;
    },
    /** Sidecar HTTP, as OpenChamber's SDK would call it. */
    async http<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<{ status: number; body: T }> {
      const res = await fetch(`${api}${path}`, {
        ...init,
        ...(init?.json !== undefined ? { method: init.method ?? "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init.json) } : {}),
      });
      const text = await res.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body };
    },
    async page(): Promise<Page> {
      browser ??= await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ["--no-sandbox"], env: { ...process.env, HOME: home } });
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      return page;
    },
    /** Restart only the sidecar (a fresh process, same disk state). SIGKILL simulates a crash: no shutdown hooks run. */
    async restartSidecar(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
      sidecar.kill(signal);
      await sidecar.exited;
      sidecar = startSidecar();
      await waitFor("sidecar", async () => (await fetch(`${api}/health`)).ok);
    },
    log(name: "sidecar" | "openchamber"): string {
      return readFileSync(join(logs, `${name}.log`), "utf8");
    },
    async stop(): Promise<void> {
      await browser?.close().catch(() => {});
      for (const child of children) child.kill();
      await Promise.all(children.map((c) => c.exited));
      if (!process.env.E2E_KEEP) rmSync(root, { recursive: true, force: true });
    },
  };
  return stack;
}

