/**
 * Session-metadata writes the sidecar makes itself, routed through OpenChamber.
 *
 * OpenChamber's UI learns that metadata changed only from its own
 * `openchamber:session-metadata` broadcast, and no OpenCode wire event carries
 * metadata. So when omp settles a goal the sidecar asks OpenChamber's server to
 * write the change (`POST /api/openchamber/sessions/:id/metadata`,
 * server/lib/openchamber-sessions/routes.js). That route merges the patch,
 * stores it by reading and PATCHing the session back through this sidecar,
 * broadcasts it to every open UI and re-arms OpenChamber's goal runtime
 * (`persistSessionMetadataPatch`, server/runtime.js).
 *
 * Where OpenChamber lives: `OC_OPENCHAMBER_URL`, else `OPENCHAMBER_HOST` and
 * `OPENCHAMBER_PORT` (the env file both services read), else loopback port 3000.
 * With `OPENCHAMBER_UI_PASSWORD` set (same env file) the sidecar logs in first.
 */
import { logger } from "../../shared/logger";

const REQUEST_TIMEOUT_MS = 5_000;

/** OpenChamber's base URL as the sidecar reaches it. */
export function openChamberUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OC_OPENCHAMBER_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  let host = env.OPENCHAMBER_HOST?.trim() || "127.0.0.1";
  if (host === "0.0.0.0" || host === "::" || host === "localhost") host = "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${env.OPENCHAMBER_PORT?.trim() || "3000"}`;
}

/** The `name=value` pairs of a response's `Set-Cookie` headers, as one `Cookie` header value. */
function cookieHeaderOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]!.trim())
    .filter(Boolean)
    .join("; ");
}

let sessionCookie: string | undefined;

async function login(base: string, password: string): Promise<string> {
  const res = await fetch(`${base}/auth/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenChamber refused the UI password (${res.status})`);
  return cookieHeaderOf(res);
}

async function post(base: string, path: string, body: unknown, cookie: string | undefined): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * Writes `patch` (a JSON merge patch) into the session's metadata through
 * OpenChamber, so its UI is told. Resolves to `undefined` on success, else to
 * why it failed (logged as a warning): the caller then writes the session
 * document itself and should tell the user the UI was not updated.
 */
export async function writeMetadataThroughOpenChamber(sessionID: string, patch: Record<string, unknown>, directory: string): Promise<string | undefined> {
  const base = openChamberUrl();
  const path = `/api/openchamber/sessions/${encodeURIComponent(sessionID)}/metadata`;
  const body = { patch, directory };
  const password = process.env.OPENCHAMBER_UI_PASSWORD;
  let reason: string;
  try {
    let res = await post(base, path, body, sessionCookie);
    if (res.status === 401 && password) {
      sessionCookie = await login(base, password);
      res = await post(base, path, body, sessionCookie);
    }
    if (res.ok) return undefined;
    reason = res.status === 401
      ? `OpenChamber at ${base} requires a login (set OPENCHAMBER_UI_PASSWORD for the sidecar)`
      : `OpenChamber at ${base} refused it (HTTP ${res.status})`;
  } catch (err) {
    reason = `OpenChamber is unreachable at ${base} (${err instanceof Error ? err.message : String(err)}; set OC_OPENCHAMBER_URL)`;
  }
  logger.warn({ sessionID, base }, `[metadata] ${reason}; writing the session directly`);
  return reason;
}

/**
 * `GET /api/omp/openchamber-bridge?session=<id>&directory=<dir>`: can the sidecar
 * reach OpenChamber and log in, and what does OpenChamber hold for that session's
 * goal? Without a session it reads a nonexistent one (expect 404/500, never 401).
 */
export async function checkOpenChamberBridge(sessionID = "ses_bridgeprobe", directory = ""): Promise<Record<string, unknown>> {
  const base = openChamberUrl();
  const password = process.env.OPENCHAMBER_UI_PASSWORD;
  const report: Record<string, unknown> = { url: base, passwordSet: Boolean(password) };
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : "";
  const probe = () => fetch(`${base}/api/openchamber/sessions/${encodeURIComponent(sessionID)}/metadata${query}`, {
    headers: sessionCookie ? { cookie: sessionCookie } : {},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  try {
    let res = await probe();
    if (res.status === 401 && password) {
      sessionCookie = await login(base, password);
      res = await probe();
    }
    report.status = res.status;
    report.authenticated = res.status !== 401;
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { metadata?: { openchamber?: { goal?: unknown } }; error?: unknown };
      report.goal = body.metadata?.openchamber?.goal ?? null;
      if (body.error) report.error = body.error;
    } catch {
      report.body = text.slice(0, 300);
    }
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
  }
  return report;
}
