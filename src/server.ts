/**
 * Sidecar entrypoint: Bun.serve, WebSocket upgrades, and the dispatch into the
 * ordered route table (`routes/index.ts`). Handlers live in `routes/`,
 * startup and shutdown in `services/runtime.ts`.
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { createClientAuthRuntime } from "./adapters/openchamber/client-auth";
import { TERMINAL_WS_PATH } from "./panels/terminal";
import { attachOpenCodeEventWebSocket } from "./shared/sse";
import { logAccess } from "./http/access-log";
import { createResponders, getCorsHeaders } from "./http/response";
import { dispatch, normalizeApiPath, resolveOpenCodeDirectoryHeader, type RouteContext } from "./http/router";
import { routeTable } from "./routes";
import { terminalRuntime } from "./services/instances";
import { resolveSidecarConfig, startRuntime } from "./services/runtime";
import { openChamberDataDir } from "./services/settings-file";
import { forwardInheritedSocket, internalSocketPath, socketActivated } from "./services/socket-activation";

interface SidecarWebSocketData {
  kind: "events" | "terminal";
  directory?: string;
}

const config = await resolveSidecarConfig();

const clientAuth = createClientAuthRuntime({
  dataDir: join(openChamberDataDir, "omp-sidecar"),
  serverLabel: hostname() || "OMP Sidecar",
  port: config.port,
  bindHost: config.host,
});

const webSocketCleanups = new WeakMap<object, () => void>();

const internalPath = socketActivated() ? internalSocketPath() : undefined;

const server = Bun.serve<SidecarWebSocketData>({
  // `unix` and `hostname`/`port` are alternatives that Bun's typings cannot see through a spread.
  ...(internalPath ? { unix: internalPath } : { hostname: config.host, port: config.port }) as { hostname: string; port: number },
  idleTimeout: 0,
  websocket: {
    open(ws) {
      if (ws.data.kind === "terminal") return terminalRuntime.ws.open(ws);
      webSocketCleanups.set(ws, attachOpenCodeEventWebSocket(ws, ws.data.directory));
    },
    message(ws, message) {
      // The global event stream is server-to-client only.
      if (ws.data.kind === "terminal") terminalRuntime.ws.message(ws, message);
    },
    close(ws) {
      if (ws.data.kind === "terminal") return terminalRuntime.ws.close(ws);
      webSocketCleanups.get(ws)?.();
      webSocketCleanups.delete(ws);
    },
  },
  async fetch(req, requestServer) {
    const reqStart = performance.now();
    const cors = getCorsHeaders(req);
    const responders = createResponders(cors);
    const url = new URL(req.url);
    const path = url.pathname;
    const dir = url.searchParams.get("directory") ?? resolveOpenCodeDirectoryHeader(req);
    const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";

    if (isUpgrade && path === TERMINAL_WS_PATH) {
      if (requestServer.upgrade(req, { data: { kind: "terminal" } })) return;
      return responders.jsonError("websocket upgrade failed", 400);
    }
    if (isUpgrade && path === "/api/global/event/ws") {
      if (requestServer.upgrade(req, { data: { kind: "events", directory: dir } })) return;
      return responders.jsonError("websocket upgrade failed", 400);
    }

    const ctx: RouteContext = {
      ...responders,
      req,
      url,
      path,
      p: normalizeApiPath(path),
      dir,
      effectiveDir: dir ?? process.cwd(),
      cors,
      clientIp: requestServer.requestIP(req)?.address ?? "unknown",
      clientAuth,
    };
    const res = await dispatch(routeTable, ctx);
    logAccess(req, url, res, Math.round(performance.now() - reqStart), responders.lastBody());
    return res;
  },
});

// With systemd's socket the public listener is systemd's (socket-activation.ts): Bun.serve stays on a private socket.
if (socketActivated()) forwardInheritedSocket(internalPath!);

startRuntime(server, config);
