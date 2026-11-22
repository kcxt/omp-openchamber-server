// service/src/main.js
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

// service/src/summary.js
var num = (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
var pointsOf = (messages) => {
  const points = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const context = message?.metadata?.omp?.context;
    if (context && num(context.used) !== undefined && num(context.at) !== undefined)
      points.push(context);
  }
  return points.sort((a, b) => a.at - b.at);
};
var compactionsOf = (messages) => {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m?.type === "compaction");
  const last = list.at(-1);
  return {
    count: list.length,
    ...last ? { lastAt: num(last.time?.created), tokensBefore: num(last.tokens?.input), tokensAfter: num(last.tokens?.output) } : {}
  };
};
var summarize = (session, messages) => {
  const points = pointsOf(messages);
  const last = points.at(-1);
  const published = session?.metadata?.openchamber?.context;
  const used = num(published?.used) ?? num(last?.used);
  const window = num(published?.window) ?? num(last?.window);
  return {
    current: used === undefined ? null : {
      used,
      window,
      percent: window ? Math.min(100, used / window * 100) : undefined,
      nonMessage: num(published?.nonMessage) ?? num(last?.nonMessage)
    },
    history: points.map((p) => ({ at: p.at, used: p.used, window: num(p.window), epoch: num(p.compactionEpoch) })),
    cache: {
      read: points.reduce((sum, p) => sum + (num(p.cacheRead) ?? 0), 0),
      write: points.reduce((sum, p) => sum + (num(p.cacheWrite) ?? 0), 0),
      lastRead: num(last?.cacheRead) ?? 0,
      lastWrite: num(last?.cacheWrite) ?? 0
    },
    compactions: compactionsOf(messages)
  };
};

// service/src/main.js
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var OPENCODE = process.env.OPENCHAMBER_OPENCODE_URL ?? "";
var SESSION_ID = /^ses_[A-Za-z0-9_-]+$/;
var authorized = (header) => {
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  const given = Buffer.from(typeof header === "string" ? header : "");
  return TOKEN !== "" && given.length === expected.length && timingSafeEqual(given, expected);
};
var send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
var read = async (path) => {
  const res = await fetch(OPENCODE + path, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok)
    throw new Error(`OpenCode answered ${res.status} for ${path}`);
  const body = await res.json();
  return body?.data ?? body;
};
http.createServer(async (req, res) => {
  if (!authorized(req.headers.authorization))
    return send(res, 401, { error: "unauthorized" });
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/health")
    return send(res, 200, { ok: true });
  if (req.method !== "GET" || url.pathname !== "/context")
    return send(res, 404, { error: "not found" });
  const sessionId = url.searchParams.get("sessionId") ?? "";
  if (!SESSION_ID.test(sessionId))
    return send(res, 400, { error: "sessionId must be an OpenCode session id" });
  if (!OPENCODE)
    return send(res, 503, { error: "OpenCode access is unavailable: approve the opencode role for this extension" });
  try {
    const [session, messages] = await Promise.all([
      read(`/api/session/${sessionId}`),
      read(`/api/session/${sessionId}/message?limit=500`)
    ]);
    send(res, 200, summarize(session, messages));
  } catch (error) {
    send(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(PORT, "127.0.0.1");
