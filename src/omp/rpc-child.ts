import { resolveOmpBinary } from "./binary";
import { createOmpCredentialRuntime, type OmpCredentialRuntime } from "./credential-runtime";
import {
  assertWorkingDirectory,
  embeddedOmpConfigOverlay,
  getSidecarExtensionPaths,
  type OmpRpcEvent,
  type OmpRpcSpawnOptions,
  type OmpRpcTransport,
} from "./rpc";

/** Minimal surface of the spawned process the transport needs. */
interface RpcProcess {
  readonly pid: number;
  readonly stdin: { write(data: unknown): void } | number | null | undefined;
  kill(): void | boolean;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
};

function withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * One omp `--mode rpc` child: NDJSON framing, request/response correlation with
 * a per-request timeout, event fan-out and death detection. It knows nothing
 * about sessions; callers drive `switch_session` themselves.
 */
export class RpcChild implements OmpRpcTransport {
  static readonly READY_TIMEOUT_MS = 30_000;
  static readonly REQUEST_TIMEOUT_MS = 30_000;
  static readonly #active = new Set<RpcChild>();

  #proc: RpcProcess;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #pending = new Map<string, PendingRequest>();
  #nextId = 1;
  #listeners = new Set<(event: OmpRpcEvent) => void>();
  #buffer = "";
  #ready = Promise.withResolvers<void>();
  #dead = false;
  #cleanup?: () => Promise<void> | void;
  #cleanupStarted = false;

  static killAll(): void {
    for (const child of [...RpcChild.#active]) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    RpcChild.#active.clear();
  }

  private constructor(proc: RpcProcess, reader: ReadableStreamDefaultReader<Uint8Array>, cleanup?: () => Promise<void> | void) {
    this.#proc = proc;
    this.#reader = reader;
    this.#cleanup = cleanup;
    // `ready` may never arrive (flaky subsystems can withhold it); a later
    // rejection of the already-abandoned promise must not crash the process.
    this.#ready.promise.catch(() => {});
    RpcChild.#active.add(this);
    this.#pump();
  }

  static async spawn(cwd: string, maxAttempts = 3, options: OmpRpcSpawnOptions = {}): Promise<RpcChild> {
    assertWorkingDirectory(cwd);
    const omp = resolveOmpBinary();
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let credentialRuntime: OmpCredentialRuntime | undefined;
      let child: RpcChild | undefined;
      try {
        credentialRuntime = options.credential ? await createOmpCredentialRuntime(options.credential) : undefined;
      } catch (err) {
        lastError = err;
        break;
      }
      const extPaths = options.disableExtensions ? [] : getSidecarExtensionPaths();
      const extArgs = extPaths.flatMap((p) => ["--extension", p]);
      const toolArgs = [
        ...(options.noTools ? ["--no-tools"] : []),
        ...(options.disableExtensions ? ["--no-extensions"] : []),
      ];
      try {
        // detached: the child leads its own process group so kill() can take
        // down MCP/LSP grandchildren instead of orphaning them.
        const proc = Bun.spawn(
          [omp, "--mode", "rpc", "--cwd", cwd, "--no-pty", "--config", embeddedOmpConfigOverlay(), ...toolArgs, ...extArgs],
          {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "inherit",
            detached: true,
            env: {
              ...Bun.env,
              ...(credentialRuntime?.env ?? {}),
              PI_SKIP_VERSION_CHECK: "1",
            },
          },
        );
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        child = new RpcChild(proc, reader, credentialRuntime?.cleanup);
        // Readiness is proven by the first real RPC response, not the
        // `ready` frame: omp processes pre-`ready` frames in order, but
        // `ready` itself can be withheld by flaky subsystems (MCP servers,
        // update checks). Whichever arrives first proves the loop is live.
        const probe = child.request("get_state");
        const probeSettled = new Promise<void>((resolve) => {
          probe.then(
            () => resolve(),
            () => resolve(),
          );
        });
        await withTimeout(
          Promise.race([probeSettled, child.#ready.promise]),
          RpcChild.READY_TIMEOUT_MS,
          `OMP not responsive after ${RpcChild.READY_TIMEOUT_MS / 1000}s (attempt ${attempt}/${maxAttempts})`,
        );
        await child.request("set_subagent_subscription", { level: "events" }).catch(() => {});
        return child;
      } catch (err) {
        lastError = err;
        if (child) child.kill();
        else await credentialRuntime?.cleanup().catch(() => {});
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`OMP spawn failed: ${String(lastError)}`);
  }

  #pump(): void {
    const decoder = new TextDecoder();
    (async () => {
      try {
        for (;;) {
          const { done, value } = await this.#reader.read();
          if (done) break;
          this.#buffer += decoder.decode(value, { stream: true });
          this.#drain();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.#fail(new Error(`RPC stdout read error: ${message}`));
      } finally {
        // A close nobody asked for (crash, OOM kill) must reach the turn
        // listeners, or the session stays "busy" with its last tool running.
        const unexpected = !this.#dead;
        this.#dead = true;
        RpcChild.#active.delete(this);
        this.#fail(new Error("RPC process closed"));
        if (unexpected) this.#handleFrame({ type: "rpc_process_closed" });
        this.#cleanupOnce();
      }
    })();
  }

  #cleanupOnce(): void {
    if (this.#cleanupStarted) return;
    this.#cleanupStarted = true;
    const cleanup = this.#cleanup;
    this.#cleanup = undefined;
    if (!cleanup) return;
    try {
      const result = cleanup();
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // Credential temp directories are best-effort cleanup after process exit.
    }
  }

  #drain(): void {
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      this.#handleFrame(frame);
    }
  }

  #handleFrame(frame: Record<string, unknown>): void {
    if (frame.type === "ready") {
      this.#ready.resolve();
      return;
    }
    if (frame.type === "response") {
      // Response frames (even malformed ones with a non-string id) never surface as events.
      if (typeof frame.id !== "string") return;
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      if (frame.success === false) {
        let message = "unknown error";
        const err = frame.error;
        if (typeof err === "object" && err !== null && "message" in err && typeof err.message === "string") {
          message = err.message;
        } else if (err !== undefined) {
          message = String(err);
        }
        pending.reject(new Error(`RPC ${pending.method}: ${message}`));
      } else {
        pending.resolve(frame.data);
      }
      return;
    }
    if (typeof frame.type === "string") {
      const event = frame as OmpRpcEvent;
      for (const listener of this.#listeners) {
        try {
          listener(event);
        } catch {
          // ignore listener errors
        }
      }
    }
  }

  #fail(err: Error): void {
    this.#ready.reject(err);
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(err);
    }
  }

  isAlive(): boolean {
    return !this.#dead;
  }

  request(method: string, params?: unknown, timeoutMs: number = RpcChild.REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.#dead) return Promise.reject(new Error(`RPC ${method}: connection dead`));
    const id = `rpc_${this.#nextId++}`;
    const body: Record<string, unknown> = { id, type: method };
    if (typeof params === "object" && params !== null && !Array.isArray(params)) Object.assign(body, params);
    const stdin = this.#proc.stdin;
    if (stdin == null || typeof stdin === "number") return Promise.reject(new Error(`RPC ${method}: stdin not available`));
    stdin.write(new TextEncoder().encode(JSON.stringify(body) + "\n"));
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      if (this.#pending.delete(id)) reject(new Error(`RPC ${method} timeout`));
    }, timeoutMs);
    this.#pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
      method,
    });
    return promise;
  }

  onEvent(handler: (event: OmpRpcEvent) => void): () => void {
    this.#listeners.add(handler);
    return () => {
      this.#listeners.delete(handler);
    };
  }

  switchSession(sessionPath: string): Promise<unknown> {
    return this.request("switch_session", { sessionPath });
  }

  sendFrame(frame: unknown): void {
    if (this.#dead) return;
    const stdin = this.#proc.stdin;
    if (stdin == null || typeof stdin === "number") return;
    stdin.write(new TextEncoder().encode(JSON.stringify(frame) + "\n"));
  }

  kill(): void {
    RpcChild.#active.delete(this);
    this.#dead = true;
    this.#fail(new Error("RPC killed"));
    this.#cleanupOnce();
    const pid = this.#proc.pid;
    if (pid > 0) {
      try {
        // Whole process group: MCP/LSP grandchild processes die with omp
        // instead of being orphaned (orphans have been observed holding
        // shared state that wedges later startups).
        process.kill(-pid, "SIGTERM");
        return;
      } catch {
        // group already gone; fall through
      }
    }
    try {
      this.#proc.kill();
    } catch {
      // ignore
    }
  }
}
