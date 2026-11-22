import { httpLogger } from "../shared/logger";

const unimplementedRoutesSeen = new Set<string>();

/**
 * OpenChamber polls many routes, most of which 404 here; keep the whole access
 * log at debug and surface only real server faults. LOG_LEVEL=debug restores
 * the per-request lines.
 */
export function logAccess(req: Request, url: URL, res: Response, durationMs: number, body: unknown): void {
  const path = url.pathname;
  let preview: unknown = body;
  if (preview === undefined && res.status === 204) {
    preview = "[no content]";
  } else if (preview === undefined) {
    preview = "[streaming]";
  }
  const text = typeof preview === "string" ? preview : JSON.stringify(preview);
  const truncated = text.length > 300 ? text.slice(0, 300) + "..." : text;

  const logData = {
    method: req.method,
    path,
    status: res.status,
    durationMs,
    search: url.search || undefined,
    response: truncated,
  };
  const logMsg = `${req.method} ${path}${url.search || ""} -> ${res.status} (${durationMs}ms) response=${truncated}`;

  if (res.status >= 500) {
    httpLogger.warn(logData, logMsg);
  } else if (res.status === 404 && truncated.includes("not implemented")) {
    // Say once per route (not per poll) which backend routes the UI asked for
    // that the sidecar does not serve.
    const routeKey = `${req.method} ${path.replace(/\/(ses|msg|prt|pair|per|que)_[A-Za-z0-9_-]+/g, "/:id")}`;
    if (!unimplementedRoutesSeen.has(routeKey)) {
      unimplementedRoutesSeen.add(routeKey);
      httpLogger.warn(`[sidecar] unimplemented route: ${routeKey}`);
    }
    httpLogger.debug(logData, logMsg);
  } else {
    httpLogger.debug(logData, logMsg);
  }
}
