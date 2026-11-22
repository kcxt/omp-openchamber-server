/**
 * `OmpCli`: stateless one-shot omp subprocesses for everything that is not a
 * driven session (PLAN §3.11). All of them are read-only: they never take a
 * lease and never write, so they cannot fork a session a terminal omp owns.
 *
 *   omp session lease --json -- <ids…>    which sessions a running omp owns (~0.2 s, batched)
 *   omp models --json                     the model catalogue (~1.8 s, cached until the config changes)
 *   omp session inspect --json <path>     model, effort, context breakdown, commands, todos, goal (~2 s, memoised)
 *
 * Children run the binary the sidecar resolves for its RPC children and the
 * sidecar's own environment.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOmpBinary } from "./binary";
import { createOmpCredentialRuntime } from "./credential-runtime";
import { assertWorkingDirectory } from "./rpc";
import type { BackendCredentials } from "../shared/types";

export interface LeaseReport {
  /** Ids a running omp holds (this sidecar's own children included). */
  held: string[];
  /** Ids omp could not determine. */
  unknown: string[];
}

/** One entry of `omp models --json`. */
export interface OmpCliModel {
  provider: string;
  id: string;
  selector: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** Supported thinking levels of a reasoning model, `null` otherwise. */
  thinking?: string[] | null;
  input?: string[];
  [key: string]: unknown;
}

/** What `omp session inspect --json` prints. */
export interface OmpInspection {
  sessionId: string;
  title: string | null;
  model: { provider: string; modelId: string } | null;
  modelFallback?: { requested: string | null; reason: string };
  thinkingLevel: string | null;
  contextBreakdown: Record<string, unknown> | null;
  contextBreakdownReason?: string;
  availableCommands: Array<{ name: string; description: string }>;
  todoPhases: unknown[];
  goal: unknown;
  leaseHeld: boolean;
}

export interface ModelCatalog {
  models: OmpCliModel[];
  /** `modelRoles.default` of omp's config when it names a listed model. */
  defaultModel?: { providerID: string; modelID: string };
}

const LEASE_TIMEOUT_MS = 20_000;
const CATALOG_TIMEOUT_MS = 60_000;
const INSPECT_TIMEOUT_MS = 60_000;
const MAX_INSPECTIONS = 128;
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max|auto)$/;

const active = new Set<Bun.Subprocess>();

function killGroup(proc: Bun.Subprocess): void {
  if (proc.pid > 0) {
    try {
      // The child leads its own group: MCP/LSP grandchildren die with it.
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch {
      // group already gone
    }
  }
  try {
    proc.kill();
  } catch {
    // ignore
  }
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

async function run(args: string[], options: RunOptions): Promise<string> {
  const proc = Bun.spawn([resolveOmpBinary(), ...args], {
    cwd: options.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    env: { ...Bun.env, PI_SKIP_VERSION_CHECK: "1", ...options.env },
  });
  active.add(proc);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(proc);
  }, options.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    if (timedOut) throw new Error(`omp ${args.slice(0, 2).join(" ")} timed out after ${options.timeoutMs / 1000}s`);
    if (code !== 0) {
      const reason = stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit code ${code}`;
      throw new Error(`omp ${args.slice(0, 2).join(" ")} failed: ${reason}`);
    }
    return stdout;
  } finally {
    clearTimeout(timer);
    active.delete(proc);
  }
}

async function runJson<T>(args: string[], options: RunOptions): Promise<T> {
  const text = (await run(args, options)).trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`omp ${args.slice(0, 2).join(" ")} printed no JSON`);
  }
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/** omp's agent directory: where it keeps `models.yml` and `config.yml`. */
function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
}

/** Changes whenever omp's model or role configuration changes. */
function configStamp(): string {
  const dir = agentDir();
  return ["models.yml", "config.yml"].map((name) => {
    try {
      return statSync(join(dir, name)).mtimeMs;
    } catch {
      return 0;
    }
  }).join(":");
}

function configuredDefault(models: OmpCliModel[]): ModelCatalog["defaultModel"] {
  try {
    const file = join(agentDir(), "config.yml");
    if (!existsSync(file)) return undefined;
    const parsed = Bun.YAML.parse(readFileSync(file, "utf8")) as { modelRoles?: Record<string, unknown> } | null;
    const role = parsed?.modelRoles?.default;
    if (typeof role !== "string") return undefined;
    const selector = role.trim().replace(THINKING_SUFFIX, "");
    const match = models.find((model) => model.selector === selector);
    return match ? { providerID: match.provider, modelID: match.id } : undefined;
  } catch {
    return undefined;
  }
}

interface LeaseWaiter {
  resolve(held: boolean | undefined): void;
  reject(error: unknown): void;
}

export class OmpCli {
  // Lease probes: callers in the same tick share one spawn; an id already being probed is joined, not re-probed.
  static readonly #leaseInflight = new Map<string, Promise<boolean | undefined>>();
  static #leaseBatch = new Map<string, LeaseWaiter>();
  static #leaseFlush?: ReturnType<typeof setTimeout>;

  static readonly #catalogs = new Map<string, { stamp: string; value: ModelCatalog }>();
  static readonly #catalogInflight = new Map<string, Promise<ModelCatalog>>();

  static readonly #inspections = new Map<string, { stamp: string; value: OmpInspection }>();
  static readonly #inspectInflight = new Map<string, Promise<OmpInspection>>();

  /** Kills every one-shot still running. */
  static shutdown(): void {
    if (OmpCli.#leaseFlush) clearTimeout(OmpCli.#leaseFlush);
    OmpCli.#leaseFlush = undefined;
    for (const proc of [...active]) killGroup(proc);
    active.clear();
  }

  /**
   * Which of `ids` a running omp holds. The prober never owns a lease, so
   * `held` is always another process (this sidecar's own children included).
   * Rejects when omp could not be asked.
   */
  static async leaseHeld(ids: string[]): Promise<LeaseReport> {
    const unique = [...new Set(ids)];
    const answers = await Promise.all(unique.map((id) => OmpCli.#probeLease(id)));
    return {
      held: unique.filter((_, index) => answers[index] === true),
      unknown: unique.filter((_, index) => answers[index] === undefined),
    };
  }

  static #probeLease(id: string): Promise<boolean | undefined> {
    const joined = OmpCli.#leaseInflight.get(id);
    if (joined) return joined;
    const probe = new Promise<boolean | undefined>((resolve, reject) => {
      OmpCli.#leaseBatch.set(id, { resolve, reject });
    });
    OmpCli.#leaseInflight.set(id, probe);
    const forget = () => {
      if (OmpCli.#leaseInflight.get(id) === probe) OmpCli.#leaseInflight.delete(id);
    };
    probe.then(forget, forget);
    OmpCli.#leaseFlush ??= setTimeout(() => void OmpCli.#flushLeases(), 0);
    return probe;
  }

  static async #flushLeases(): Promise<void> {
    const batch = OmpCli.#leaseBatch;
    OmpCli.#leaseBatch = new Map();
    OmpCli.#leaseFlush = undefined;
    if (batch.size === 0) return;
    try {
      const report = await runJson<{ held?: unknown; unknown?: unknown }>(
        ["session", "lease", "--json", "--", ...batch.keys()],
        { timeoutMs: LEASE_TIMEOUT_MS },
      );
      const held = new Set(stringList(report.held));
      const unknown = new Set(stringList(report.unknown));
      for (const [id, waiter] of batch) waiter.resolve(held.has(id) ? true : unknown.has(id) ? undefined : false);
    } catch (error) {
      for (const waiter of batch.values()) waiter.reject(error);
    }
  }

  /**
   * omp's model catalogue. Cached until omp's `models.yml`/`config.yml` change;
   * a caller with its own credentials runs against its own agent directory and
   * bypasses the cache.
   */
  static async models(options: { cwd?: string; credential?: BackendCredentials } = {}): Promise<ModelCatalog> {
    const cwd = options.cwd ?? process.cwd();
    assertWorkingDirectory(cwd);
    if (options.credential) {
      const runtime = await createOmpCredentialRuntime(options.credential);
      try {
        const { models } = await runJson<{ models?: OmpCliModel[] }>(["models", "--json"], { cwd, env: runtime.env, timeoutMs: CATALOG_TIMEOUT_MS });
        return { models: models ?? [] };
      } finally {
        await runtime.cleanup().catch(() => {});
      }
    }
    const key = `${resolveOmpBinary()}\0${agentDir()}\0${cwd}`;
    const stamp = configStamp();
    const cached = OmpCli.#catalogs.get(key);
    if (cached && cached.stamp === stamp) return cached.value;
    const inflightKey = `${key}\0${stamp}`;
    const pending = OmpCli.#catalogInflight.get(inflightKey);
    if (pending) return pending;
    const load = (async () => {
      const { models = [] } = await runJson<{ models?: OmpCliModel[] }>(["models", "--json"], { cwd, timeoutMs: CATALOG_TIMEOUT_MS });
      const value: ModelCatalog = { models, defaultModel: configuredDefault(models) };
      OmpCli.#catalogs.set(key, { stamp, value });
      return value;
    })().finally(() => OmpCli.#catalogInflight.delete(inflightKey));
    OmpCli.#catalogInflight.set(inflightKey, load);
    return load;
  }

  /**
   * What a live omp would report for the transcript at `path`, read-only.
   * Memoised by the file's (path, size, mtimeMs); concurrent calls share one spawn.
   * `fresh` skips the memo for answers that depend on more than the transcript (the command list).
   */
  static async inspect(path: string, cwd?: string, options: { fresh?: boolean } = {}): Promise<OmpInspection> {
    const info = await stat(path);
    const stamp = `${info.size}:${info.mtimeMs}`;
    const memo = OmpCli.#inspections.get(path);
    if (memo?.stamp === stamp && !options.fresh) return memo.value;
    const inflightKey = `${path}\0${stamp}`;
    const pending = OmpCli.#inspectInflight.get(inflightKey);
    if (pending) return pending;
    const load = (async () => {
      const value = await runJson<OmpInspection>(["session", "inspect", "--json", path], {
        cwd: cwd && existsSync(cwd) ? cwd : undefined,
        timeoutMs: INSPECT_TIMEOUT_MS,
      });
      OmpCli.#inspections.delete(path);
      OmpCli.#inspections.set(path, { stamp, value });
      if (OmpCli.#inspections.size > MAX_INSPECTIONS) OmpCli.#inspections.delete(OmpCli.#inspections.keys().next().value!);
      return value;
    })().finally(() => OmpCli.#inspectInflight.delete(inflightKey));
    OmpCli.#inspectInflight.set(inflightKey, load);
    return load;
  }
}
