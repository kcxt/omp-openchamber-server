/** Transcript reads: message list/get, raw context, and the omp context breakdown. */
import { followSession } from "../adapters/openchamber/follow";
import { loadOmpContext } from "../adapters/openchamber/omp-context";
import { page, toV2Message } from "../adapters/openchamber/v2";
import { MissingWorkingDirectoryError } from "../providers/omp/rpc";
import type { RouteContext } from "../http/router";
import { resolveSessionRoute } from "../services/session-route";

export async function handleTranscript(ctx: RouteContext): Promise<Response | undefined> {
  const { req, url, path, p, dir, json, jsonError } = ctx;
  const contextMatch = path.match(/^\/api\/omp\/context\/([^/]+)$/);
  if (contextMatch && req.method === "GET") {
    try {
      const sessionId = decodeURIComponent(contextMatch[1]!);
      const { backend, session } = await resolveSessionRoute(sessionId, dir);
      if (!session) return jsonError("session not found", 404);
      return json(await loadOmpContext(backend, session, { breakdown: url.searchParams.get("breakdown") === "1" }));
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "context lookup failed", 500);
    }
  }

  // Session messages
  const msgMatch = p.match(/^\/session\/([^/]+)\/message$/);
  if (msgMatch && req.method === "GET") {
    try {
      const { backend, session } = await resolveSessionRoute(msgMatch[1], dir);
      if (!session) return jsonError("session not found", 404);
      const messages = await backend.store.transcript(msgMatch[1], session.directory);
      // Anything a terminal omp appends to this session from now on is pushed live.
      if (messages != null) followSession(msgMatch[1], session.directory, session.path);
      if (messages == null) return jsonError("load failed", 500);
      const ordered = [...messages]
        .sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0))
        .map(toV2Message);
      const requestedLimit = url.searchParams.get("limit");
      const parsedLimit = requestedLimit == null ? 100 : Number.parseInt(requestedLimit, 10);
      const pageLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 500)) : 100;
      const order = !url.searchParams.get("cursor") && url.searchParams.get("order") === "asc" ? "asc" : "desc";
      const currentPage = page(ordered, pageLimit, url.searchParams.get("cursor"), order);
      return json({ data: currentPage.data, cursor: currentPage.cursor });
    } catch (err) {
      if (err instanceof MissingWorkingDirectoryError) {
        return json({ error: err.message, reason: err.reason, cwd: err.cwd }, { status: err.statusCode });
      }
      return jsonError(err instanceof Error ? err.message : "load failed", 500);
    }
  }

  const messageGetMatch = p.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
  if (messageGetMatch && req.method === "GET") {
    try {
      const sessionID = decodeURIComponent(messageGetMatch[1]!);
      const messageID = decodeURIComponent(messageGetMatch[2]!);
      const { backend, session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const messages = await backend.store.transcript(sessionID, session.directory);
      const message = messages?.find((entry) => entry.info.id === messageID);
      if (!message) return jsonError("message not found", 404);
      return json({ data: toV2Message(message) });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "message lookup failed", 500);
    }
  }

  const sessionContextMatch = p.match(/^\/session\/([^/]+)\/context$/);
  if (sessionContextMatch && req.method === "GET") {
    try {
      const sessionID = decodeURIComponent(sessionContextMatch[1]!);
      const { backend, session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const messages = await backend.store.transcript(sessionID, session.directory);
      if (messages == null) return jsonError("load failed", 500);
      return json({ data: messages.map(toV2Message) });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "context lookup failed", 500);
    }
  }

  return undefined;
}
