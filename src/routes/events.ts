/** Event streams (SSE; the WebSocket twin is upgraded in `server.ts`) and the notification acknowledgement stubs. */
import { createOpenCodeEventStream } from "../shared/sse";
import type { RouteContext } from "../http/router";

const EVENT_STREAM_PATHS: ReadonlySet<string> = new Set(["/event", "/events", "/global/event", "/openchamber/events"]);

export async function handleEvents(ctx: RouteContext): Promise<Response | undefined> {
  const { req, url, p, dir, cors, json } = ctx;
  if (EVENT_STREAM_PATHS.has(p)) {
    const isBrowserParam = url.searchParams.get("browser") === "1";
    const isOpenChamberStream = p === "/openchamber/events";
    return new Response(createOpenCodeEventStream(dir, { browserCapable: isBrowserParam, isOpenChamber: isOpenChamberStream }), {
      headers: {
        ...cors,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  // Message sent acknowledgement (push notifications / activity tracking)
  const msgSentMatch = p.match(/^\/(?:api\/)?sessions\/([^/]+)\/message-sent$/);
  if (msgSentMatch && req.method === "POST") {
    const sessionId = msgSentMatch[1];
    return json({ success: true, sessionId, messageSent: true });
  }

  // Notification auto-accept
  if (p === "/notifications/auto-accept" && req.method === "POST") {
    return json({ success: true });
  }

  return undefined;
}
