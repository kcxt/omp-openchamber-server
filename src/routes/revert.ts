/** Staged revert: stage, clear (redo), commit, and the legacy revert/unrevert echo. */
import { emitOpenCodeV2Event } from "../shared/sse";
import type { RouteContext } from "../http/router";
import { asRecord, readJson } from "../http/response";
import { commitStagedRevert, resolveSessionRoute } from "../services/session-route";
import { clearRevert, SessionOpError, stageRevert } from "../sessions/service";

export async function handleRevert(ctx: RouteContext): Promise<Response | undefined> {
  const { req, p, dir, json, jsonError, noContent } = ctx;
  const fail = (err: unknown, fallback: string) =>
    jsonError(err instanceof Error ? err.message : fallback, err instanceof SessionOpError ? err.status : 500);

  const revertStageMatch = p.match(/^\/session\/([^/]+)\/revert\/stage$/);
  if (revertStageMatch && req.method === "POST") {
    try {
      const sessionID = decodeURIComponent(revertStageMatch[1]!);
      const { session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      const body = asRecord(await readJson(req));
      if (typeof body?.messageID !== "string") return jsonError("messageID required", 400);
      const revert = await stageRevert(session, body.messageID);
      emitOpenCodeV2Event("session.revert.staged", { sessionID, revert }, session.directory);
      return json({ data: revert });
    } catch (err) {
      return fail(err, "revert stage failed");
    }
  }

  const revertClearMatch = p.match(/^\/session\/([^/]+)\/revert$/);
  if (revertClearMatch && req.method === "DELETE") {
    try {
      const sessionID = decodeURIComponent(revertClearMatch[1]!);
      const { session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      await clearRevert(session);
      emitOpenCodeV2Event("session.revert.cleared", { sessionID }, session.directory);
      return noContent();
    } catch (err) {
      return fail(err, "revert clear failed");
    }
  }

  const revertCommitMatch = p.match(/^\/session\/([^/]+)\/revert\/commit$/);
  if (revertCommitMatch && req.method === "POST") {
    try {
      const sessionID = decodeURIComponent(revertCommitMatch[1]!);
      const { session } = await resolveSessionRoute(sessionID, dir);
      if (!session) return jsonError("session not found", 404);
      if ((await commitStagedRevert(sessionID, session)) === "none") return jsonError("no staged revert", 409);
      return noContent();
    } catch (err) {
      return fail(err, "revert commit failed");
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
