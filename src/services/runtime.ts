/** Sidecar startup and shutdown: CLI/env resolution, banner, endpoint file, signal handling. */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseCliArgs, printHelp } from "../adapters/openchamber/cli";
import { resolveProviderConnection, resolveSmallModel } from "../adapters/openchamber/small-model";
import { shutdownSessions } from "../sessions/service";
import { stopFollowingAll } from "../adapters/openchamber/follow";
import { listOmpSessions } from "../store/sessions";
import { ensureOmpBinary, getOmpRuntimeInfo, probeOmpVersion, setExplicitOmpBinary } from "../omp/binary";
import { getSidecarExtensionPaths } from "../omp/rpc";
import { startOmpUpdateChecker } from "../omp/update-check";
import { logger } from "../shared/logger";
import { browserControlBroker, messageQueueRuntime, terminalRuntime } from "./instances";
import { openChamberDataDir } from "./settings-file";
import { runImporter } from "../store/importer";
import { openChamberUrl } from "../adapters/openchamber/metadata-bridge";

export interface SidecarConfig {
  host: string;
  port: number;
}

/**
 * Parses the CLI, exports its overrides to the environment, locates omp.
 * `OC_SIDECAR_PORT` overrides the default 4096 so the route-level test suite
 * can run a second instance without colliding with the live sidecar. Bun
 * binds 127.0.0.1 unless `OC_SIDECAR_HOST` widens that to a tailnet address
 * (`tailscale ip -4`) so OpenChamber on another device can add the server
 * without an ssh tunnel.
 */
export async function resolveSidecarConfig(): Promise<SidecarConfig> {
  let options: ReturnType<typeof parseCliArgs>;
  try {
    options = parseCliArgs();
  } catch (err: any) {
    console.error(`[sidecar] Error: ${err?.message || err}`);
    process.exit(1);
  }

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.binary) setExplicitOmpBinary(options.binary);
  if (options.port !== undefined) process.env.OC_SIDECAR_PORT = String(options.port);
  if (options.host) process.env.OC_SIDECAR_HOST = options.host;

  await ensureOmpBinary();
  // Before any omp child can open a session: transcripts must hold only omp's own entries.
  const migration = await runImporter();
  if (migration.errors.length > 0) logger.warn({ errors: migration.errors }, "[sidecar] session data migration left errors; affected sessions keep their old files");
  else if (migration.sessions.length > 0) logger.info({ sessions: migration.sessions.length }, "[sidecar] migrated sidecar session records");

  return {
    host: process.env.OC_SIDECAR_HOST || "127.0.0.1",
    port: Number(process.env.OC_SIDECAR_PORT ?? 4096),
  };
}

function logStartupBanner(sidecarHost: string, port?: number): void {
  const effectivePort = port ?? 4096;
  const extPaths = getSidecarExtensionPaths();
  const extensions = extPaths.length > 0 ? extPaths.map((p) => basename(p)).join(", ") : "none";
  const ompRuntime = getOmpRuntimeInfo();
  const smallModel = resolveSmallModel();
  let smallModelInfo = "none configured";
  if (smallModel) {
    const conn = resolveProviderConnection(smallModel.providerID);
    const authStatus = conn?.apiKey ? "authenticated" : conn?.baseURL ? "endpoint ready" : "no credentials found";
    smallModelInfo = `${smallModel.providerID}/${smallModel.modelID} (source: ${smallModel.source}, endpoint: ${conn?.baseURL || "unknown"}, status: ${authStatus})`;
  }

  logger.info(`[sidecar] 🚀 OMP Sidecar started successfully`);
  logger.info(`[sidecar] Listening on http://${sidecarHost}:${effectivePort}`);
  logger.info(`[sidecar] OpenChamber (goal results, metadata): ${openChamberUrl()}${process.env.OPENCHAMBER_UI_PASSWORD ? " with the UI password" : ""}`);
  logger.info(`[sidecar] Configuration:`);
  logger.info(`  • Working directory : ${process.cwd()}`);
  logger.info(`  • OMP version       : ${ompRuntime.version ?? "unknown"} (${ompRuntime.source})`);
  if (ompRuntime.binary) {
    logger.info(`  • OMP binary        : ${ompRuntime.binary}`);
  }
  logger.info(`  • Small model       : ${smallModelInfo}`);
  logger.info(`  • Extensions        : ${extensions}`);
  logger.info(`  • Browser control   : ready`);

  if (ompRuntime.binary && !ompRuntime.version) {
    void probeOmpVersion(ompRuntime.binary).then((version) => {
      if (version) logger.info(`[sidecar] OMP version detected: ${version} (${ompRuntime.source})`);
    });
  }
}

/**
 * Guest services spawn without the host environment, so they cannot learn a
 * non-default OC_SIDECAR_PORT. They read this file instead
 * (extensions/omp-settings/service).
 */
function publishEndpoint(host: string, port: number): void {
  try {
    const endpointDir = join(openChamberDataDir, "omp-sidecar");
    mkdirSync(endpointDir, { recursive: true });
    const reachable = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    writeFileSync(join(endpointDir, "endpoint.json"), JSON.stringify({ url: `http://${reachable}:${port}`, pid: process.pid }));
  } catch (err) {
    logger.warn({ err }, "[sidecar] could not publish endpoint.json");
  }
}

/** Everything that runs once the server is listening. */
export function startRuntime(server: { port?: number; stop(closeActiveConnections?: boolean): unknown }, config: SidecarConfig): void {
  logStartupBanner(config.host, server.port);
  publishEndpoint(config.host, server.port ?? config.port);
  messageQueueRuntime.start();
  const stopOmpUpdateChecker = startOmpUpdateChecker();

  // Parse every session header once, in the background, so OpenChamber's first
  // global session list (its goal recovery runs one on connect and gives up
  // after a few seconds) is a cache hit instead of a multi-second cold scan.
  void listOmpSessions(null, { all: true }).catch(() => {});

  // Keepalive interval so Bun's event loop wakes up frequently to process POSIX signals
  // (SIGINT/SIGTERM) immediately even when Bun.serve has no pending I/O.
  const signalKeepalive = setInterval(() => {}, 100);

  // Graceful shutdown: SIGTERM/SIGINT/SIGTSTP tears down every OMP child instead of
  // leaving them orphaned.
  let shuttingDown = false;
  function handleShutdownSignal(signal: string) {
    if (shuttingDown) {
      process.exit(0);
    }
    shuttingDown = true;
    clearInterval(signalKeepalive);
    stopOmpUpdateChecker();
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      if (typeof process.stdin.unref === "function") {
        process.stdin.unref();
      }
    } catch {
      // ignore
    }
    try {
      process.stderr.write(`\n[proxy] ${signal} received, shutting down...\n`);
    } catch {
      // ignore
    }
    try {
      logger.info({ signal }, `[proxy] ${signal} received, shutting down`);
      if (typeof (logger as any).flush === "function") {
        (logger as any).flush();
      }
    } catch {
      // ignore
    }
    try {
      browserControlBroker.rejectAll("Server shutting down");
      messageQueueRuntime.stop();
      void terminalRuntime.shutdown();
      shutdownSessions();
      stopFollowingAll();
    } catch {
      // ignore
    }
    try {
      server.stop(true);
    } catch {
      // ignore
    }
    process.exit(0);
  }

  // Leave the terminal in normal line mode on process exit in case shutdown began
  // while another code path had changed its mode.
  process.on("exit", () => {
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
    } catch {
      // ignore
    }
  });

  process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
  process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
  process.on("SIGTSTP", () => handleShutdownSignal("SIGTSTP"));
  process.on("SIGHUP", () => handleShutdownSignal("SIGHUP"));
  process.on("SIGQUIT", () => handleShutdownSignal("SIGQUIT"));
  process.on("SIGBREAK", () => handleShutdownSignal("SIGBREAK"));

  // Keep stdin in normal terminal mode so input is echoed and Enter advances the
  // console. The terminal turns Ctrl+C, Ctrl+Z, and Ctrl+\ into signals handled
  // above; the byte checks also cover control characters from non-TTY stdin.
  try {
    process.stdin.resume();
    if (process.stdin.isTTY) {
      // In normal terminal mode Ctrl+D is delivered as EOF instead of a byte.
      process.stdin.on("end", () => handleShutdownSignal("EOF"));
    }
    process.stdin.on("data", (chunk) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (s.includes("\u0003") || s.includes("\u0004")) {
        handleShutdownSignal("SIGINT");
      } else if (s.includes("\u001a")) {
        handleShutdownSignal("SIGTSTP");
      } else if (s.includes("\u001c")) {
        handleShutdownSignal("SIGQUIT");
      }
    });
  } catch {
    // ignore
  }
}
