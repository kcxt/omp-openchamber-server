/**
 * Everything the user answers: permission requests, questions/forms, the
 * message queue and the inbox view of it, and the notification stream.
 */
import { randomUUID } from "node:crypto";
import {
  listPendingPermissions,
  listPendingQuestions,
  getPendingPermission,
  getPendingQuestion,
  replyPermission,
  replyQuestion,
  rejectQuestion,
  getAutoAcceptPolicy,
  setSessionAutoAccept,
  toOpenCodePermissionRequest,
  toOpenCodeFormRequest,
  toQuestionAnswers,
} from "../adapters/openchamber/approvals";
import { isQueueError } from "../adapters/openchamber/message-queue";
import { toV2FileAttachment } from "../adapters/openchamber/v2";
import {
  createOpenChamberNotificationStream,
  emitPermissionReplied,
  emitQuestionReplied,
  emitQuestionRejected,
  emitOpenCodeV2Event,
} from "../shared/sse";
import type { RouteContext } from "../http/router";
import { asRecord, readJson } from "../http/response";
import { Registry } from "../sessions/registry";
import { SessionDocs } from "../store/session-docs";
import { readSessionIdSync } from "../store/sessions";
import { messageQueueRuntime } from "../services/instances";
import { resolveSessionRoute } from "../services/session-route";

export async function handleInteractions(ctx: RouteContext): Promise<Response | undefined> {
  const { req, path, p, dir, cors, json, jsonError, noContent } = ctx;
  // Permission auto-accept policy
  if (path === "/api/permission-auto-accept" || path === "/permission-auto-accept") {
    return json(getAutoAcceptPolicy());
  }

  const autoAcceptMatch = path.match(/^\/(?:api\/)?permission-auto-accept\/sessions\/([^/]+)$/);
  if (autoAcceptMatch) {
    const sessionId = decodeURIComponent(autoAcceptMatch[1]);
    if (req.method === "PUT" || req.method === "POST") {
      const body = (await readJson(req)) as { enabled?: boolean } | undefined;
      const enabled = body?.enabled ?? true;
      return json(setSessionAutoAccept(sessionId, enabled));
    }
    return json(getAutoAcceptPolicy());
  }

  const queueError = (error: unknown, fallback: string): Response => (
    isQueueError(error)
      ? jsonError(error.message, error.status)
      : jsonError(error instanceof Error ? error.message : fallback, 500)
  );

  if (p === "/message-queue" && req.method === "GET") {
    try {
      await messageQueueRuntime.load();
      return json(messageQueueRuntime.snapshot());
    } catch (error) {
      return queueError(error, "failed to load message queue");
    }
  }

  const queueItemsMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/items$/);
  if (queueItemsMatch && req.method === "POST") {
    try {
      const body = asRecord(await readJson(req));
      return json(await messageQueueRuntime.enqueue(
        decodeURIComponent(queueItemsMatch[1]),
        body?.directory,
        body?.item,
      ));
    } catch (error) {
      return queueError(error, "failed to queue message");
    }
  }

  const queueTakeAllMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/take$/);
  if (queueTakeAllMatch && req.method === "POST") {
    try {
      return json(await messageQueueRuntime.takeAll(decodeURIComponent(queueTakeAllMatch[1])));
    } catch (error) {
      return queueError(error, "failed to take queued messages");
    }
  }

  const queueOrderMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/order$/);
  if (queueOrderMatch && req.method === "PUT") {
    try {
      const body = asRecord(await readJson(req));
      return json(await messageQueueRuntime.reorder(
        decodeURIComponent(queueOrderMatch[1]),
        body?.itemIds,
      ));
    } catch (error) {
      return queueError(error, "failed to reorder queue");
    }
  }

  const queueHoldMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/hold$/);
  if (queueHoldMatch && req.method === "PUT") {
    try {
      const body = asRecord(await readJson(req));
      await messageQueueRuntime.load();
      return json(messageQueueRuntime.setHold(
        decodeURIComponent(queueHoldMatch[1]),
        body?.held,
        body?.ttlMs,
      ));
    } catch (error) {
      return queueError(error, "failed to update queue hold");
    }
  }

  const queueSessionMatch = p.match(/^\/message-queue\/sessions\/([^/]+)$/);
  if (queueSessionMatch && req.method === "DELETE") {
    try {
      return json(await messageQueueRuntime.clear(decodeURIComponent(queueSessionMatch[1])));
    } catch (error) {
      return queueError(error, "failed to clear queue");
    }
  }

  const queueItemActionMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/items\/([^/]+)\/(take)$/);
  if (queueItemActionMatch && req.method === "POST") {
    try {
      return json(await messageQueueRuntime.take(
        decodeURIComponent(queueItemActionMatch[1]),
        decodeURIComponent(queueItemActionMatch[2]),
      ));
    } catch (error) {
      return queueError(error, "failed to take queued message");
    }
  }

  const queueItemDeleteMatch = p.match(/^\/message-queue\/sessions\/([^/]+)\/items\/([^/]+)$/);
  if (queueItemDeleteMatch && req.method === "DELETE") {
    try {
      return json(await messageQueueRuntime.remove(
        decodeURIComponent(queueItemDeleteMatch[1]),
        decodeURIComponent(queueItemDeleteMatch[2]),
      ));
    } catch (error) {
      return queueError(error, "failed to remove queued message");
    }
  }

  // OpenCode v2 inbox view of the same pending prompts the message-queue
  // routes expose. Items use the prompt payload shape the client maps into
  // optimistic user messages.
  const inboxMatch = p.match(/^\/session\/([^/]+)\/inbox$/);
  if (inboxMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(inboxMatch[1]!);
    try {
      await messageQueueRuntime.load();
    } catch (error) {
      return queueError(error, "failed to load message queue");
    }
    const entry = messageQueueRuntime.snapshot().sessions.find((session) => session.sessionId === sessionId);
    const items = (entry?.items ?? []).map((item) => {
      const files = item.attachments.flatMap((attachment) => {
        const uri = attachment.serverPath;
        if (!uri) return [];
        return [toV2FileAttachment({ uri, mime: attachment.mimeType, name: attachment.filename })];
      });
      return {
        id: item.id,
        sessionID: sessionId,
        type: "user",
        time: { created: item.createdAt },
        delivery: "queue",
        payload: {
          text: item.text,
          ...(files.length > 0 ? { files } : {}),
          ...(item.agentMention ? { agents: [item.agentMention] } : {}),
        },
      };
    });
    // Prompts omp holds undelivered (a steer waiting for a step boundary, a follow-up): the client shows them
    // pending after the streaming reply, and without this list a reload or session switch drops them. omp
    // lists them; a subagent's session has no runtime of its own, so its parent's runtime answers for it.
    const { session } = await resolveSessionRoute(sessionId, dir);
    const owner = session ? Registry.findSubagent(session.id) : undefined;
    const held = !session ? [] : owner ? await owner.runtime.subagentPendingInbox(session.id) : await Registry.get(session.id, session.directory)?.pendingInbox() ?? [];
    const visible = session ? (await SessionDocs.get(readSessionIdSync(session.path) ?? "").catch(() => undefined))?.visibleParts ?? {} : {};
    const base = Date.now();
    held.forEach((entry, index) => {
      if (items.some((item) => item.id === entry.id)) return;
      // omp holds the whole message (context and file text included); what the user typed is the bubble.
      const typed = visible[entry.id]?.map((part) => part.text).join("\n\n");
      const files = ("images" in entry ? entry.images ?? [] : []).map((image) => toV2FileAttachment({ uri: `data:${image.mimeType};base64,${image.data}`, mime: image.mimeType }));
      items.push({
        id: entry.id,
        sessionID: sessionId,
        type: "user",
        time: { created: base + index },
        delivery: entry.delivery,
        payload: { text: typed ?? entry.text, ...(files.length > 0 ? { files } : {}) },
      } as (typeof items)[number]);
    });
    return json({ data: items });
  }

  const inboxItemMatch = p.match(/^\/session\/([^/]+)\/inbox\/([^/]+)$/);
  if (inboxItemMatch) {
    const sessionId = decodeURIComponent(inboxItemMatch[1]!);
    const itemId = decodeURIComponent(inboxItemMatch[2]!);
    if (req.method === "DELETE") {
      try {
        await messageQueueRuntime.remove(sessionId, itemId);
        // The client added the item optimistically; without the removal
        // event it stays in the transcript as a message that never ran.
        emitOpenCodeV2Event("session.inbox.cancelled", { sessionID: sessionId, inboxID: itemId }, dir);
        return noContent();
      } catch (error) {
        return queueError(error, "failed to cancel queued message");
      }
    }
    if (req.method === "PATCH") {
      // Delivery is chosen by the prompt request; a queued item cannot be
      // re-tagged, so the sidecar rejects instead of faking a switch.
      return jsonError("queued message delivery mode cannot be changed", 409);
    }
  }

  if (p === "/notifications/stream" && req.method === "GET") {
    return new Response(createOpenChamberNotificationStream(), {
      headers: {
        ...cors,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const sessionFormListMatch = p.match(/^\/session\/([^/]+)\/form$/);
  if (sessionFormListMatch && req.method === "GET") {
    const sessionID = decodeURIComponent(sessionFormListMatch[1]!);
    const forms = listPendingQuestions(dir).filter((request) => request.sessionID === sessionID).map(toOpenCodeFormRequest);
    return json({ data: forms });
  }

  const sessionFormMatch = p.match(/^\/session\/([^/]+)\/form\/([^/]+)$/);
  if (sessionFormMatch && req.method === "GET") {
    const sessionID = decodeURIComponent(sessionFormMatch[1]!);
    const formID = decodeURIComponent(sessionFormMatch[2]!);
    const pending = getPendingQuestion(formID);
    if (!pending || pending.sessionID !== sessionID) return jsonError("form not found", 404);
    return json({ data: { ...toOpenCodeFormRequest(pending), state: { status: "pending" } } });
  }

  // `DELETE /form/:id` and `POST /form/:id/cancel` both reject the pending question.
  const formRejectMatch = p.match(/^\/session\/([^/]+)\/form\/([^/]+?)(\/cancel)?$/);
  if (formRejectMatch && (formRejectMatch[3] ? req.method === "POST" : req.method === "DELETE")) {
    const sessionID = decodeURIComponent(formRejectMatch[1]!);
    const formID = decodeURIComponent(formRejectMatch[2]!);
    const pending = getPendingQuestion(formID);
    if (!pending || pending.sessionID !== sessionID) return jsonError("form not found", 404);
    return rejectQuestion(formID) ? noContent() : jsonError("form not found", 404);
  }

  // Adapt OpenCode's typed form actions to the sidecar's pending question
  // requests. The pending question id is the form id on the wire.
  const formReplyMatch = p.match(/^\/session\/([^/]+)\/form\/([^/]+)\/reply$/);
  if (formReplyMatch && req.method === "POST") {
    const [, sessionID, formID] = formReplyMatch;
    const pending = getPendingQuestion(formID!);
    if (!pending || pending.sessionID !== sessionID) return jsonError("form not found", 404);
    const body = asRecord(await readJson(req));
    const answer = asRecord(body?.answer);
    if (!answer) return jsonError("answer required", 400);
    const ok = replyQuestion(formID!, toQuestionAnswers(pending, answer));
    return ok ? noContent() : jsonError("form not found", 404);
  }

  // Questions & Permissions
  if (p === "/form" && req.method === "GET") {
    return json({ location: { directory: dir ?? process.cwd() }, data: listPendingQuestions(dir).map(toOpenCodeFormRequest) });
  }

  if (p === "/permission/request" && req.method === "GET") {
    return json({ location: { directory: dir ?? process.cwd() }, data: listPendingPermissions(dir).map(toOpenCodePermissionRequest) });
  }

  const sessionPermissionMatch = p.match(/^\/session\/([^/]+)\/permission(?:\/([^/]+)(?:\/reply)?)?$/);
  if (sessionPermissionMatch) {
    const sessionID = decodeURIComponent(sessionPermissionMatch[1]!);
    const requestID = sessionPermissionMatch[2] ? decodeURIComponent(sessionPermissionMatch[2]) : undefined;
    const isReply = p.endsWith("/reply");
    const { session } = await resolveSessionRoute(sessionID, dir);
    if (!session) return jsonError("session not found", 404);

    if (!requestID && req.method === "GET") {
      return json({ data: listPendingPermissions(session.directory)
        .filter((request) => request.sessionID === sessionID)
        .map(toOpenCodePermissionRequest) });
    }
    if (!requestID && req.method === "POST") {
      const body = asRecord(await readJson(req));
      if (typeof body?.action !== "string" || !Array.isArray(body.resources)) return jsonError("action and resources are required", 400);
      const id = typeof body.id === "string" ? body.id : randomUUID();
      return json({ data: { id, effect: "ask" } });
    }
    if (requestID && req.method === "GET" && !isReply) {
      const request = getPendingPermission(requestID);
      if (!request || request.sessionID !== sessionID) return jsonError("permission not found", 404);
      return json({ data: toOpenCodePermissionRequest(request) });
    }
    if (requestID && req.method === "POST" && isReply) {
      const body = asRecord(await readJson(req));
      const decision = body?.decision === "always" || body?.decision === "reject" ? body.decision : "once";
      const request = getPendingPermission(requestID);
      if (!request || request.sessionID !== sessionID) return jsonError("permission not found", 404);
      const ok = replyPermission(requestID, decision);
      if (!ok) return jsonError("permission not found", 404);
      emitPermissionReplied(sessionID, requestID, decision, session.directory);
      return noContent();
    }
  }

  if (p === "/permission" && req.method === "GET") {
    return json(listPendingPermissions(dir));
  }

  const permReplyMatch = p.match(/^\/permission\/([^/]+)\/reply$/);
  if (permReplyMatch && req.method === "POST") {
    const id = permReplyMatch[1];
    const body = (await readJson(req)) as { reply?: "once" | "always" | "reject"; decision?: "once" | "always" | "reject"; message?: string } | undefined;
    const reply = body?.decision ?? body?.reply ?? "once";
    const perm = getPendingPermission(id);
    const ok = replyPermission(id, reply);
    if (ok && perm) {
      emitPermissionReplied(perm.sessionID, id, reply, perm.directory);
    }
    return json(ok);
  }

  if (p === "/question" && req.method === "GET") {
    return json(listPendingQuestions(dir));
  }

  const qReplyMatch = p.match(/^\/question\/([^/]+)\/reply$/);
  if (qReplyMatch && req.method === "POST") {
    const id = qReplyMatch[1];
    const body = (await readJson(req)) as { answers?: string[][] } | undefined;
    const q = getPendingQuestion(id);
    const ok = replyQuestion(id, body?.answers ?? []);
    if (ok && q) {
      emitQuestionReplied(q.sessionID, id, body?.answers ?? [], q.directory);
    }
    return json(ok);
  }

  const qRejectMatch = p.match(/^\/question\/([^/]+)\/reject$/);
  if (qRejectMatch && req.method === "POST") {
    const id = qRejectMatch[1];
    const q = getPendingQuestion(id);
    const ok = rejectQuestion(id);
    if (ok && q) {
      emitQuestionRejected(q.sessionID, id, q.directory);
    }
    return json(ok);
  }

  return undefined;
}
