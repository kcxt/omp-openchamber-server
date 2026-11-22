/**
 * Optional child supervision (`OC_CHILD_SUPERVISOR=systemd`): each omp child runs as a transient
 * systemd user unit instead of a child of the sidecar, so a sidecar restart (a new release) does
 * not touch it. The sidecar talks to a child through two named FIFOs, never through pipes it owns:
 *
 *   in   sidecar -> omp stdin      out   omp stdout -> sidecar
 *
 * The unit's wrapper opens both read-write (`<>`). That makes the child itself a reader and a
 * writer of its own FIFOs, so the sidecar going away is neither an EOF on stdin nor an EPIPE on
 * stdout: frames written meanwhile wait in the FIFO (64 KiB, then omp's write blocks, which is
 * backpressure, not loss). When omp exits, the wrapper writes one `rpc_process_closed` frame
 * into `out`, so death reaches the sidecar in-band and in order, whoever is attached.
 *
 * A ledger record per child (`<dir>/<unit>.json`) is what a new sidecar adopts from.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** systemd's per-unit variables of the sidecar's own unit; they describe the sidecar, not the child. */
const SIDECAR_UNIT_VARS = /^(LISTEN_PID|LISTEN_FDS|LISTEN_FDNAMES|INVOCATION_ID|JOURNAL_STREAM|SYSTEMD_EXEC_PID|MANAGERPID|NOTIFY_SOCKET|WATCHDOG_PID|WATCHDOG_USEC)$/;

export const supervised = (): boolean => process.env.OC_CHILD_SUPERVISOR === "systemd";

/**
 * Where FIFOs and ledger records live: `OC_SUPERVISOR_DIR`, else systemd's `RuntimeDirectory=` (preserved across
 * restarts), else `$XDG_RUNTIME_DIR/omp-sidecar`. The shipped unit sets `OC_SUPERVISOR_DIR` to a directory its
 * sandbox already binds read-write; `ProtectHome=tmpfs` also hides `/run/user`.
 */
export function supervisorDir(): string {
  const dir = process.env.OC_SUPERVISOR_DIR
    ?? process.env.RUNTIME_DIRECTORY?.split(":")[0]
    ?? (process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "omp-sidecar") : undefined);
  if (!dir) throw new Error("child supervision needs OC_SUPERVISOR_DIR, RuntimeDirectory= or XDG_RUNTIME_DIR");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export interface ChildHandle {
  unit: string;
  fifoIn: string;
  fifoOut: string;
}

/** What a new sidecar needs to take a running child over. */
export interface ChildRecord extends ChildHandle {
  cwd: string;
  /** Set by the owning runtime once the session is open. */
  sessionId?: string;
  transcriptPath?: string;
  credentialFingerprint?: string;
  /** Private agent dir of a credentialed child, removed when it ends. */
  credentialDir?: string;
  /** A partial line read from `out` before the previous sidecar went away. */
  rest?: string;
}

async function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/** The part of the unit name between `@` and `.service`: what the template's `%i` is, and what names the spec files and FIFOs. */
const instanceOf = (unit: string): string => unit.slice(unit.indexOf("@") + 1, -".service".length);

export function newHandle(sessionId: string): ChildHandle {
  const instance = `${sessionId.replace(/[^A-Za-z0-9_.]/g, "_")}-${Date.now().toString(36)}`;
  const dir = supervisorDir();
  return { unit: `omp-child@${instance}.service`, fifoIn: join(dir, `${instance}.in`), fifoOut: join(dir, `${instance}.out`) };
}

const nul = (items: string[]): string => items.map((item) => `${item}\0`).join("");

/**
 * Creates the FIFOs and starts an instance of `omp-child@.service`. What to run reaches it as credentials
 * (`LoadCredential=` in the template reads `<instance>.cwd|env|argv` from the supervisor directory when the unit
 * starts); `systemctl start` returns when the process is forked, which can be before the manager has read them, so the sidecar
 * cannot remove them: `bin/omp-child` does, once it has read its private copy. A failed start is removed here.
 * Resolves with the unit's main pid.
 */
export async function startChildUnit(
  handle: ChildHandle,
  options: { argv: string[]; cwd: string; env: Record<string, string | undefined> },
): Promise<number> {
  for (const fifo of [handle.fifoIn, handle.fifoOut]) {
    const made = await run(["mkfifo", "-m", "600", fifo]);
    if (made.code !== 0) throw new Error(`mkfifo ${fifo}: ${made.err.trim()}`);
  }
  const base = join(supervisorDir(), instanceOf(handle.unit));
  const specs = [`${base}.cwd`, `${base}.env`, `${base}.argv`];
  const env = Object.entries(options.env)
    .filter(([key, value]) => value !== undefined && !SIDECAR_UNIT_VARS.test(key))
    .map(([key, value]) => `${key}=${value}`);
  try {
    writeFileSync(specs[0]!, nul([options.cwd]), { mode: 0o600 });
    writeFileSync(specs[1]!, nul(env), { mode: 0o600 });
    writeFileSync(specs[2]!, nul(options.argv), { mode: 0o600 });
    const started = await run(["systemctl", "--user", "start", handle.unit]);
    if (started.code !== 0) throw new Error(`start ${handle.unit}: ${started.err.trim() || `exit ${started.code}`}`);
  } catch (err) {
    removeFifos(handle);
    for (const spec of specs) rmSync(spec, { force: true });
    throw err;
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await childUnitState(handle.unit);
    if (state.mainPid > 0) return state.mainPid;
    await Bun.sleep(40);
  }
  throw new Error(`${handle.unit} did not start`);
}

export async function childUnitState(unit: string): Promise<{ active: boolean; mainPid: number }> {
  const shown = await run(["systemctl", "--user", "show", unit, "-p", "ActiveState", "-p", "MainPID"]);
  const value = (key: string) => shown.out.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
  return { active: value("ActiveState") === "active" || value("ActiveState") === "activating", mainPid: Number(value("MainPID")) || 0 };
}

export async function stopChildUnit(unit: string): Promise<void> {
  await run(["systemctl", "--user", "stop", unit]);
}

/** Every omp child unit that is running, whoever started it. */
export async function liveChildUnits(): Promise<Set<string>> {
  // `omp-child*` also matches the transient `omp-child-<session>-<n>` units an earlier release left running.
  const listed = await run(["systemctl", "--user", "list-units", "omp-child*.service", "--plain", "--no-legend", "--state=active,activating,deactivating"]);
  return new Set(listed.out.split("\n").map((line) => line.trim().split(/\s+/)[0]!).filter(Boolean));
}

export function removeFifos(handle: ChildHandle): void {
  rmSync(handle.fifoIn, { force: true });
  rmSync(handle.fifoOut, { force: true });
}

// ------------------------------------------------------------------ ledger

const recordPath = (unit: string) => join(supervisorDir(), `${unit}.json`);

export function writeRecord(record: ChildRecord): void {
  writeFileSync(recordPath(record.unit), JSON.stringify(record), { mode: 0o600 });
}

export function readRecord(unit: string): ChildRecord | undefined {
  try {
    return JSON.parse(readFileSync(recordPath(unit), "utf8")) as ChildRecord;
  } catch {
    return undefined;
  }
}

export function readRecords(): ChildRecord[] {
  return readdirSync(supervisorDir())
    .filter((name) => name.endsWith(".service.json"))
    .flatMap((name) => readRecord(name.slice(0, -".json".length)) ?? []);
}

export function removeRecord(handle: ChildHandle): void {
  rmSync(recordPath(handle.unit), { force: true });
  removeFifos(handle);
}
