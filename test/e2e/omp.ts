// A second omp instance for tests: "the user's terminal omp". It is the stub in RPC mode,
// so the sessions it writes (and the leases it takes) are the ones real omp would.
import type { Stack } from "./stack";

type Frame = Record<string, any>;

export class OmpInstance {
  #proc: ReturnType<typeof Bun.spawn>;
  #pending = new Map<string, (frame: Frame) => void>();
  #waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  #next = 1;

  private constructor(proc: ReturnType<typeof Bun.spawn>) {
    this.#proc = proc;
    void this.#pump();
  }

  static async start(stack: Stack, cwd: string, env: Record<string, string> = {}): Promise<OmpInstance> {
    const proc = Bun.spawn([stack.stubBin, "--mode", "rpc", "--cwd", cwd], {
      env: { ...stack.env, OMP_STUB_RECORD: "", ...env },
      stdin: "pipe", stdout: "pipe", stderr: "inherit",
    });
    const omp = new OmpInstance(proc);
    await omp.#waitFor((f) => f.type === "ready");
    return omp;
  }

  async #pump() {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.#proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Frame;
        if (frame.type === "response" && frame.id) this.#pending.get(frame.id)?.(frame);
        this.#waiters = this.#waiters.filter((w) => (w.match(frame) ? (w.resolve(frame), false) : true));
      }
    }
  }

  #waitFor(match: (f: Frame) => boolean): Promise<Frame> {
    return new Promise((resolve) => this.#waiters.push({ match, resolve }));
  }

  async request<T = any>(type: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = `t${this.#next++}`;
    const response = new Promise<Frame>((resolve) => this.#pending.set(id, resolve));
    (this.#proc.stdin as import("bun").FileSink).write(JSON.stringify({ id, type, ...params }) + "\n");
    const frame = await response;
    if (!frame.success) throw new Error(`${type}: ${frame.error}`);
    return frame.data as T;
  }

  /** Send a prompt and wait for the turn to finish. */
  async prompt(message: string): Promise<void> {
    const done = this.#waitFor((f) => f.type === "prompt_result");
    await this.request("prompt", { message });
    await done;
  }

  async resume(sessionFile: string): Promise<void> {
    await this.request("switch_session", { sessionPath: sessionFile });
  }

  state() {
    return this.request<{ sessionFile?: string; sessionId: string }>("get_state");
  }

  async close(): Promise<void> {
    (this.#proc.stdin as import("bun").FileSink).end();
    await this.#proc.exited;
  }
}
