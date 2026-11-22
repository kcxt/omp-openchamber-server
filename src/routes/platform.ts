/**
 * Platform surface: health/version probes, auth and client-auth, browser
 * control, project setup, and the stub endpoints OpenChamber probes and
 * expects an answer from.
 */
import { mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { handleProjectContextRequest } from "../panels/project-context";
import { BrowserControlError } from "../panels/browser-control";
import { getOmpRuntimeInfo } from "../providers/omp/binary";
import { apiOrGet, type RouteContext } from "../http/router";
import { readJson } from "../http/response";
import { emptyProjectSetup, projectPathFromId } from "../services/projects";
import { browserControlBroker, projectContextRuntime } from "../services/instances";
import { logger } from "../shared/logger";

// OpenChamber's host probe (packages/electron/electron-host-probe.mjs) reads
// /api/version and marks a server `incompatible` when the reported major is
// below 2. This adapter speaks the OpenCode v2 surface, so it advertises the
// `@opencode/client` generation it was checked against, not a 1.x release.
const OPENCHAMBER_API_VERSION = "2.0.14";

// OpenChamber's readiness gate (server/lib/opencode/compatibility.js) parses
// GET /api/info as an OpenCode version and accepts only 2.x at or above 2.2.4;
// anything else leaves the backend parked and every proxied route answers 503
// "OpenCode is restarting". The sidecar speaks the OpenCode v2 HTTP contract,
// so it advertises that contract level here and reports the OMP runtime
// separately as `ompVersion`.
const OPENCODE_API_COMPAT_VERSION = "2.2.4";

const COMPATIBILITY = {
  apiVersion: 1,
  minClientApiVersion: 1,
  capabilities: [
    "api.health.v1",
    "api.runtime-url.v1",
    "api.raw-file.v1",
    "realtime.sse.v1",
    "realtime.websocket.global-events.v1",
    "terminal.websocket.v1",
  ],
};

const startTime = Date.now();

export async function handlePlatform(ctx: RouteContext): Promise<Response | undefined> {
  const { req, url, path, p, dir, effectiveDir, json, jsonError, clientIp, clientAuth } = ctx;
  const projectContextRoute = await handleProjectContextRequest(req, url, projectContextRuntime);
  if (projectContextRoute) {
    return json(
      projectContextRoute.body,
      projectContextRoute.status === undefined ? undefined : { status: projectContextRoute.status },
    );
  }

  // Health
  if (
    path === "/health" ||
    path === "/global/health" ||
    path === "/api/health" ||
    path === "/api/opencode/health"
  ) {
    return json({
      healthy: true,
      status: "ok",
      compatibility: COMPATIBILITY,
    });
  }

  // OpenCode 2.0.8+ uses /api/info as its readiness probe. `version` is the
  // OpenCode API level this sidecar implements; the OMP runtime behind it is
  // reported alongside it.
  if (path === "/api/info" && req.method === "GET") {
    return json({
      version: OPENCODE_API_COMPAT_VERSION,
      ompVersion: getOmpRuntimeInfo().version ?? "unknown",
      pid: process.pid,
      urls: [url.origin],
      paths: { tmp: tmpdir() },
    });
  }

  // OpenChamber Desktop / Web version probe
  if (path === "/api/version") {
    return json({
      status: "ok",
      openchamberVersion: OPENCHAMBER_API_VERSION,
      runtime: "omp-sidecar",
      startedAt: startTime,
      compatibility: COMPATIBILITY,
    });
  }

  // OpenChamber guest catalog compatibility. The OMP sidecar does not
  // own OpenChamber guest packages, but the UI expects a successful empty
  // catalog rather than a missing route.
  if (path === "/api/guests" && req.method === "GET") {
    return json({ guests: [] });
  }

  // OpenChamber auth session probe
  if (path === "/auth/session" || path === "/api/auth/session") {
    return json({
      authenticated: true,
      scope: "local",
    });
  }

  // OpenChamber passkey status
  if (path === "/auth/passkey/status" || path === "/api/auth/passkey/status") {
    return json({
      enabled: false,
      hasPasskeys: false,
      passkeyCount: 0,
      rpID: null,
    });
  }

  // OpenChamber url-token & client token auth
  if (path === "/auth/url-token" || path === "/api/auth/url-token") {
    return json({
      token: "omp-local-url-token",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
  }

  // OpenChamber "Add device": pairing sessions, device list, revoke.
  if (path.startsWith("/api/client-auth/")) {
    const authResponse = await clientAuth.handle(req, url, path, clientIp);
    if (authResponse) return json(authResponse.data, { status: authResponse.status, headers: authResponse.headers });
  }

  // OpenChamber project setup is optional for the OMP sidecar. Return the
  // contract's empty setup so the UI can continue creating sessions while
  // making it explicit that this adapter does not own project settings.
  const projectConfigMatch = path.match(/^\/api\/projects\/([^/]+)\/config(\/shared)?$/);
  if (projectConfigMatch) {
    const projectPath = projectPathFromId(decodeURIComponent(projectConfigMatch[1]));
    if (!projectPath) return jsonError("invalid project id", 400);
    if (req.method === "GET") return json(emptyProjectSetup(projectPath));
    return jsonError("project config writes are not supported by the OMP sidecar", 501);
  }

  // Browser Control Claim
  if ((path === "/api/browser-control/claim" || path === "/browser-control/claim") && req.method === "POST") {
    const body = (await readJson(req)) as { requestId?: string } | undefined;
    const requestId = body?.requestId?.trim() || "";
    if (!requestId) return jsonError("requestId is required", 400);
    return json({ granted: browserControlBroker.claim(requestId) });
  }

  // Browser Control Result
  if ((path === "/api/browser-control/result" || path === "/browser-control/result") && req.method === "POST") {
    const body = (await readJson(req)) as { requestId?: string; ok?: boolean; data?: unknown; error?: string } | undefined;
    const requestId = body?.requestId?.trim() || "";
    if (!requestId) return jsonError("requestId is required", 400);
    const matched = browserControlBroker.resolve(requestId, {
      ok: body?.ok === true,
      data: body?.data,
      error: body?.error,
    });
    return json({ matched });
  }

  // Internal Browser Control Request (used by openchamber_web extension)
  if (path === "/internal/browser-control/request" && req.method === "POST") {
    const body = (await readJson(req)) as { action?: string; parameters?: Record<string, unknown>; timeoutMs?: number; directory?: string } | undefined;
    const action = body?.action?.trim() || "";
    if (!action) return jsonError("action is required", 400);
    try {
      const sidecarPort = Number(process.env.OC_SIDECAR_PORT ?? 4096);
      const targetDir = body?.directory?.trim() || effectiveDir;
      const data = await browserControlBroker.request(action, body?.parameters ?? {}, {
        timeoutMs: body?.timeoutMs,
        baseDir: targetDir,
        port: sidecarPort,
      });

      // Handle screenshot capture persistence and validation
      if ((action === "browser.capture" || action === "capture") && data && typeof data === "object") {
        let captureData = data as { base64?: string; mime?: string; width?: number; height?: number; [key: string]: unknown };

        // If the panel is newly opened or mid-animation, give the UI transition 800ms to paint and retry once
        if (!captureData.base64 || captureData.width === 0 || captureData.height === 0) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          try {
            const retryResult = await browserControlBroker.request(action, body?.parameters ?? {}, {
              timeoutMs: body?.timeoutMs,
              baseDir: targetDir,
              port: sidecarPort,
            });
            if (retryResult && typeof retryResult === "object") {
              captureData = retryResult as typeof captureData;
            }
          } catch {
            /* continue to check */
          }
        }

        if (!captureData.base64 || captureData.width === 0 || captureData.height === 0) {
          throw new BrowserControlError(
            "The in-app browser view is currently hidden or not rendered (captured 0x0 pixels). Please ensure the OpenChamber browser panel is open and visible on screen.",
            400,
          );
        }
        try {
          const screenshotsDir = join(targetDir, ".openchamber", "screenshots");
          await mkdir(screenshotsDir, { recursive: true });
          const rawLabel = typeof body?.parameters?.label === "string" ? body.parameters.label.trim() : "capture";
          const cleanLabel = rawLabel.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "capture";
          const ext = captureData.mime?.includes("png") ? "png" : "jpg";
          const filename = `screenshot-${Date.now()}-${cleanLabel}.${ext}`;
          const filepath = join(screenshotsDir, filename);
          const buffer = Buffer.from(captureData.base64, "base64");
          writeFileSync(filepath, buffer);
          const enhancedData = {
            ...captureData,
            path: filepath,
            hint: `Screenshot saved to ${filepath}. Write ![](${filepath}) in your response to display it.`,
          };
          return json({ ok: true, data: enhancedData });
        } catch (err: any) {
          if (err instanceof BrowserControlError) throw err;
          logger.warn(`Failed to save screenshot to disk: ${err?.message || err}`);
        }
      }

      return json({ ok: true, data });
    } catch (err) {
      const status = err instanceof BrowserControlError ? err.status : 500;
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status });
    }
  }

  // System URL probe (for dev server preview detection)
  if (path === "/api/system/probe-url" && req.method === "POST") {
    const body = (await readJson(req)) as { url?: string } | undefined;
    const target = body?.url;
    if (!target) return json({ ok: false, error: "Invalid URL" }, { status: 400 });
    try {
      const resp = await fetch(target, { method: "GET", signal: AbortSignal.timeout(1500) });
      return json({ ok: resp.status >= 200 && resp.status < 600, status: resp.status });
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : "Probe failed" });
    }
  }

  // Linear is not owned by the sidecar. Return the same neutral status
  // shape as OpenChamber's server uses when no workspace is connected so
  // the UI can hide the integration without treating it as a server error.
  if (path === "/api/linear/auth/status" && req.method === "GET") {
    return json({ connected: false });
  }

  if (path === "/api/openchamber/update-check") {
    return json({ hasUpdate: false });
  }

  // Spaces archives and Received-pages live in OpenChamber's web server.
  // Through the sidecar they are empty/disabled, and reporting that keeps
  // the client on its unavailable path instead of a 404.
  if (path === "/api/openchamber/spaces/archives" || path === "/openchamber/spaces/archives") {
    return json({ archives: [] });
  }

  if (path === "/api/openchamber/received-pages/config" || path === "/openchamber/received-pages/config") {
    return json({ available: false, bases: [] });
  }

  if (path === "/api/openchamber/models-metadata") {
    try {
      const resp = await fetch("https://models.dev/api.json", {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const data = await resp.json();
        return json(data);
      }
    } catch {
      // ignore
    }
    return json({});
  }

  if (path === "/api/opencode/upgrade-status") {
    return json({
      available: false,
      currentVersion: OPENCHAMBER_API_VERSION,
      latestVersion: OPENCHAMBER_API_VERSION,
      upgrade: {
        supported: false,
        manager: null,
        reason: "external",
      },
    });
  }

  if (path === "/api/push/visibility") {
    return json({});
  }

  // Neither integration is owned by the sidecar. `/api/x` answers any method;
  // the bare alias answers GET.
  if (p === "/github/auth/status" && apiOrGet(ctx)) {
    return json({ authenticated: false });
  }

  if (p === "/session-folders" && apiOrGet(ctx)) {
    return json([]);
  }

  // Lists the UI probes; omp has no equivalents, so they are empty rather than missing.
  if ((p === "/websearch/provider" || p === "/plugin") && req.method === "GET") {
    return json({ data: [] });
  }

  // Background work the sidecar can report. omp's own background jobs are
  // not surfaced, so both lists are empty, but they must answer: the goal
  // loop treats an unanswered list as "could not look" and never audits.
  if (p === "/experimental/job" && req.method === "GET") return json({ data: [] });
  if (p === "/shell" && req.method === "GET") return json({ location: { directory: effectiveDir }, data: [] });

  // OpenCode credential store and integration catalog. omp owns credentials
  // (agent.db / env), so there are none to report; OpenChamber reads these
  // to label provider sources and the quota list, and treats empty as
  // "nothing stored here", where a 404 is logged as a failure.
  if (p === "/credential" && req.method === "GET") return json({ data: [] });
  if (p === "/integration" && req.method === "GET") return json({ location: { directory: effectiveDir }, data: [] });

  // Project
  if (p === "/project" && req.method === "GET") {
    return json([
      {
        id: "global",
        canonical: effectiveDir,
        name: basename(effectiveDir),
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    ]);
  }

  if (p === "/project/current" && req.method === "GET") {
    return json({
      id: "global",
      worktree: effectiveDir,
      path: effectiveDir,
      directory: effectiveDir,
      label: "Project",
      time: { created: Date.now(), updated: Date.now() },
    });
  }

  if (p === "/location" && req.method === "GET") {
    return json({
      directory: effectiveDir,
      project: {
        id: "global",
        directory: effectiveDir,
        canonical: effectiveDir,
      },
    });
  }

  // Path
  if (p === "/path" && req.method === "GET") {
    const home = Bun.env.HOME || "";
    return json({
      home,
      state: effectiveDir,
      config: effectiveDir,
      worktree: effectiveDir,
      directory: effectiveDir,
    });
  }

  // LSP
  if (p === "/lsp" && req.method === "GET") return json([]);

  // VCS
  if (p === "/vcs" && req.method === "GET") {
    return json({ location: { directory: dir ?? process.cwd() }, data: { branch: { current: "main", default: "main" } } });
  }

  // System info (About dialog)
  if (path === "/api/system/info" || path === "/system/info") {
    return json({
      version: OPENCHAMBER_API_VERSION,
      platform: process.platform,
      arch: process.arch,
      runtime: "omp-sidecar",
      node: process.version,
      bun: Bun.version,
    });
  }

  // Behavior AGENTS.md editor
  if (path === "/api/behavior/agents-md" || path === "/behavior/agents-md") {
    const checkDir = url.searchParams.get("directory") || effectiveDir;
    const agentsMdPath = join(checkDir, "AGENTS.md");
    const exists = existsSync(agentsMdPath);
    if (req.method === "GET") {
      let content = "";
      if (exists) {
        try {
          content = readFileSync(agentsMdPath, "utf8");
        } catch {
          // ignore
        }
      }
      return json({ exists, content, path: agentsMdPath });
    }
    if (req.method === "POST" || req.method === "PUT") {
      const body = (await readJson(req)) as { content?: string } | undefined;
      try {
        writeFileSync(agentsMdPath, body?.content ?? "");
        return json({ exists: true, content: body?.content ?? "", path: agentsMdPath });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "write failed", 500);
      }
    }
  }

  // Project icons
  if (path.startsWith("/api/projects/") && path.includes("/icon")) {
    return json({ icon: null, discovered: null });
  }

  // Magic prompts
  if (path === "/api/magic-prompts" || path.startsWith("/api/magic-prompts/")) {
    if (req.method === "GET") return json([]);
    return json({ success: true });
  }

  // Scheduled tasks & cron loops
  if (path.includes("/scheduled-tasks")) {
    if (path.endsWith("/status")) return json({ running: false, tasks: [] });
    if (req.method === "GET") return json([]);
    return json({ success: true });
  }

  // Agent memory
  if (path.startsWith("/api/agent-memory")) {
    if (req.method === "GET") return json({ memories: [], total: 0 });
    return json({ success: true });
  }

  // Walkthrough generator
  if (path.startsWith("/api/walkthrough")) {
    if (path.endsWith("/progress")) return json({ progress: 100, status: "idle" });
    return json({ walkthrough: null });
  }

  // Dictation & Speech
  if (path.startsWith("/api/dictation") || path.startsWith("/api/tts")) {
    return json({ available: false, voices: [], models: [] });
  }

  // Dev servers & preview detection
  if (path.startsWith("/api/dev-servers")) {
    return json({ servers: [] });
  }

  // Tunnels (Cloudflare / ngrok)
  if (path.startsWith("/api/openchamber/tunnel")) {
    return json({ active: false, providers: [], status: "stopped" });
  }

  // Markdown image grants
  if (p === "/markdown-image-grants" || path === "/api/markdown-image-grants") {
    return json([]);
  }

  if ((p.startsWith("/quota/") || p.startsWith("/api/quota/")) && req.method === "GET") {
    const providerId = p.replace(/^\/(?:api\/)?quota\//, "");
    // Quota reporting is owned by the OpenChamber web server. The sidecar
    // does not have the provider-specific credentials/API integrations, but
    // it still needs to return the ProviderResult shape so the usage panel
    // can render an unavailable provider instead of failing schema parsing.
    return json({
      providerId,
      providerName: providerId,
      ok: false,
      configured: false,
      usage: null,
      error: "Quota reporting is unavailable through the OMP sidecar",
      fetchedAt: Date.now(),
    });
  }

  return undefined;
}
