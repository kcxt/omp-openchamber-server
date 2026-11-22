/**
 * systemd socket activation (`omp-server.socket`): the unit's listener outlives the sidecar, so
 * connections made while a restart is in progress wait in the kernel's backlog instead of being
 * refused, and the new process serves them.
 *
 * Bun.serve cannot adopt an inherited descriptor (`node:http` `listen({ fd })` is accepted and then
 * never serves), but `node:net` can. So the inherited socket is accepted with `node:net` and each
 * connection is piped to Bun.serve, which listens on a private unix socket. HTTP, SSE and
 * WebSocket upgrades are bytes to this layer. The cost is the peer address: `requestIP` has none on
 * a unix socket, so `RouteContext.clientIp` is "unknown" in this mode.
 */
import { createServer, connect, type Server } from "node:net";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { supervisorDir } from "../omp/supervisor";

/** First descriptor systemd passes (`SD_LISTEN_FDS_START`). */
const FIRST_FD = 3;

let forwarder: Server | undefined;

/** True when systemd handed this process a listening socket. */
export function socketActivated(): boolean {
  return Number(process.env.LISTEN_PID) === process.pid && Number(process.env.LISTEN_FDS) >= 1;
}

/** Where Bun.serve listens when the public socket is systemd's. Stale files from a previous process are removed. */
export function internalSocketPath(): string {
  const path = join(supervisorDir(), "http.sock");
  rmSync(path, { force: true });
  return path;
}

/** Accepts on the inherited socket and pipes every connection to `target` (a unix socket path). */
export function forwardInheritedSocket(target: string): Server {
  const server = createServer({ pauseOnConnect: false }, (client) => {
    const upstream = connect(target);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen({ fd: FIRST_FD });
  forwarder = server;
  return server;
}

/**
 * Shutdown: stop accepting (what is still queued stays in systemd's socket for the next process), then give
 * requests in flight up to `ms` to finish. Streams that never end (SSE, WebSockets) are cut at the deadline;
 * their clients reconnect to the next process.
 */
export async function drainForwarder(ms: number): Promise<void> {
  const server = forwarder;
  if (!server) return;
  await Promise.race([new Promise<void>((resolve) => server.close(() => resolve())), Bun.sleep(ms)]);
}
