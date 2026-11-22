/** Staged revert: stage, clear, commit, and the legacy revert/unrevert echo. */
import { emitOpenCodeV2Event } from "../shared/sse";
import type { RouteContext } from "../http/router";
import { asRecord, readJson } from "../http/response";
import { commitStagedRevert, resolveSessionRoute } from "../services/session-route";

export async function handleRevert(ctx: RouteContext): Promise<Response | undefined> {
  const { req, p, dir, json, jsonError, noContent } = ctx;
  const revertStageMatch = p.match(/^\/session\/([^/]+)\/revert\/stage$/);
  if (revertStageMatch && req.method === "POST") {
    try {
      const sessionID = decodeURIComponent(revertStageMatch[1]!);
      const { backend, session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const body = asRecord(await readJson(req));
      if (typeof body?.messageID !== "string") return jsonError("messageID required", 400);
      const revert = { messageID: body.messageID };
      const updated = await backend.store.update(sessionID, { revert }, session.directory);
      if (!updated) return jsonError("session not found", 404);
      emitOpenCodeV2Event("session.revert.staged", { sessionID, revert }, session.directory);
      return json({ data: revert });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "revert stage failed", 500);
    }
  }

  const revertClearMatch = p.match(/^\/session\/([^/]+)\/revert$/);
  if (revertClearMatch && req.method === "DELETE") {
    try {
      const sessionID = decodeURIComponent(revertClearMatch[1]!);
      const { backend, session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const updated = await backend.store.update(sessionID, { revert: null }, session.directory);
      if (!updated) return jsonError("session not found", 404);
      emitOpenCodeV2Event("session.revert.cleared", { sessionID }, session.directory);
      return noContent();
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "revert clear failed", 500);
    }
  }

  const revertCommitMatch = p.match(/^\/session\/([^/]+)\/revert\/commit$/);
  if (revertCommitMatch && req.method === "POST") {
    try {
      const sessionID = decodeURIComponent(revertCommitMatch[1]!);
      const { backend, session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const result = await commitStagedRevert(sessionID, backend, session);
      if (result === "none") return jsonError("no staged revert", 409);
      if (result === "boundary-missing") return jsonError("revert boundary not found", 404);
      return noContent();
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "revert commit failed", 500);
    }
  }

  // Session revert & unrevert
  const revertMatch = p.match(/^\/session\/([^/]+)\/(revert|unrevert)$/);
  if (revertMatch && req.method === "POST") {
    try {
      const { session } = await resolveSessionRoute(revertMatch[1], dir);
      if (!session) return jsonError("session not found", 404);
      return json(session);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "revert failed", 500);
    }
  }

  return undefined;
}
