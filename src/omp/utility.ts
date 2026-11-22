import { RpcChild } from "./rpc-child";

/** Idle window after which a utility child with no request in flight is released. */
function idleMs(): number {
  const configured = Number(process.env.OC_CHILD_IDLE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 120_000;
}

export interface LeaseReport {
  held: string[];
  unknown: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * One long-lived, sessionless omp child per cwd, for questions that do not need
 * a session runtime: model and command lists, lease probes, context breakdowns
 * of undriven sessions, shell commands. Created on first use (single-flight),
 * released after OC_CHILD_IDLE_MS without requests, respawned after it dies.
 */
export class Utility {
  static readonly #byCwd = new Map<string, Utility>();

  static for(cwd: string): Utility {
    let utility = Utility.#byCwd.get(cwd);
    if (!utility) {
      utility = new Utility(cwd);
      Utility.#byCwd.set(cwd, utility);
    }
    return utility;
  }

  /** Kills every utility child; the next request respawns. */
  static shutdown(): void {
    for (const utility of Utility.#byCwd.values()) utility.release();
    Utility.#byCwd.clear();
  }

  readonly cwd: string;
  #child?: RpcChild;
  #starting?: Promise<RpcChild>;
  #inflight = 0;
  #idleTimer?: ReturnType<typeof setTimeout>;
  #breakdownTail: Promise<unknown> = Promise.resolve();

  private constructor(cwd: string) {
    this.cwd = cwd;
  }

  async #acquire(): Promise<RpcChild> {
    if (this.#child?.isAlive()) return this.#child;
    this.#child = undefined;
    this.#starting ??= RpcChild.spawn(this.cwd).then(
      (child) => {
        this.#starting = undefined;
        this.#child = child;
        return child;
      },
      (error: unknown) => {
        this.#starting = undefined;
        throw error;
      },
    );
    return this.#starting;
  }

  #armIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    if (this.#inflight > 0 || !this.#child) return;
    this.#idleTimer = setTimeout(() => this.release(), idleMs());
    this.#idleTimer.unref?.();
  }

  /** Kills this utility's child, if any. */
  release(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    const child = this.#child;
    this.#child = undefined;
    child?.kill();
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    this.#inflight++;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    try {
      const child = await this.#acquire();
      return await child.request(method, params, timeoutMs);
    } finally {
      this.#inflight--;
      this.#armIdle();
    }
  }

  /**
   * Which of `sessionIds` another process holds. A fresh omp that never opened
   * the session cannot hold the lease itself, so `held` is always a foreign
   * owner. `unknown` lists ids omp could not determine.
   */
  async leaseHeld(sessionIds: string[]): Promise<LeaseReport> {
    const lease = (await this.request("get_session_lease", { sessionIds })) as { held?: unknown; unknown?: unknown } | undefined;
    return { held: stringList(lease?.held), unknown: stringList(lease?.unknown) };
  }

  availableModels(): Promise<unknown> {
    return this.request("get_available_models");
  }

  availableCommands(): Promise<unknown> {
    return this.request("get_available_commands");
  }

  /** omp's categorical context breakdown for a transcript: switch_session onto the path, then get_context_breakdown. Serialised per utility. */
  contextBreakdown(sessionPath: string): Promise<unknown> {
    const run = this.#breakdownTail.then(async () => {
      await this.request("switch_session", { sessionPath });
      return this.request("get_context_breakdown");
    });
    this.#breakdownTail = run.catch(() => {});
    return run;
  }

  bash(command: string, timeoutMs?: number): Promise<unknown> {
    return this.request("bash", { command }, timeoutMs);
  }
}
