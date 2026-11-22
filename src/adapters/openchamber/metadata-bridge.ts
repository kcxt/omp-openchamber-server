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
 * OpenChamber, so its UI is told. Returns false, after logging a warning, when
 * OpenChamber could not be reached or refused: the caller then writes the
 * session document itself.
 */
export async function writeMetadataThroughOpenChamber(sessionID: string, patch: Record<string, unknown>, directory: string): Promise<boolean> {
  const base = openChamberUrl();
  const path = `/api/openchamber/sessions/${encodeURIComponent(sessionID)}/metadata`;
  const body = { patch, directory };
  const password = process.env.OPENCHAMBER_UI_PASSWORD;
  try {
    let res = await post(base, path, body, sessionCookie);
    if (res.status === 401 && password) {
      sessionCookie = await login(base, password);
      res = await post(base, path, body, sessionCookie);
    }
    if (res.ok) return true;
    logger.warn({ sessionID, status: res.status, base }, "[metadata] OpenChamber refused the metadata write; writing the session directly");
  } catch (err) {
    logger.warn({ err, sessionID, base }, "[metadata] OpenChamber is unreachable (set OC_OPENCHAMBER_URL); writing the session directly");
  }
  return false;
}
