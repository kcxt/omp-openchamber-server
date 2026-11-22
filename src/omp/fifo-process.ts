import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import { stopChildUnit, type ChildHandle } from "./supervisor";

/**
 * The sidecar's end of a supervised child (`supervisor.ts`): omp's stdin and stdout as the FIFOs
 * the unit's wrapper opened. Both are opened read-write, which never blocks and never reports EOF,
 * so attaching works whether or not the child is up, and detaching leaves the child undisturbed.
 */
export class FifoProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stdin: { write(data: unknown): void };
  readonly #read: ReadStream;
  readonly #write: WriteStream;

  constructor(readonly handle: ChildHandle, readonly pid: number) {
    this.#read = createReadStream(handle.fifoOut, { flags: "r+" });
    this.#write = createWriteStream(handle.fifoIn, { flags: "r+" });
    // A write error means the sidecar's end is gone; the child's death is reported in-band, not here.
    this.#write.on("error", () => {});
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#read.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
        this.#read.on("error", (err) => controller.error(err));
      },
      cancel: () => {
        this.#read.destroy();
      },
    });
    this.stdin = { write: (data) => void this.#write.write(data as Uint8Array) };
  }

  /** Stops the unit (the child and everything it started). */
  kill(): void {
    void stopChildUnit(this.handle.unit);
  }

  /** Lets go of both FIFOs and leaves the child running. */
  release(): void {
    this.#read.destroy();
    this.#write.destroy();
  }
}
