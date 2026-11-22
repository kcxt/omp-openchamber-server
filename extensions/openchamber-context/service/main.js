// service/main.ts
import http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// service/breakdown.ts
var HISTORY_POINTS = 40;
var GROWTH_WINDOW = 10;
var CACHE_TTL_MS = 5 * 60000;
var OMP_CATEGORIES = ["systemPrompt", "systemTools", "systemContext", "instructionFiles", "skills", "messages"];
var num = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
function buildReport(context) {
  const { current, breakdown } = context;
  if (!current)
    return { status: "no-turn" };
  const limit = num(breakdown?.contextWindow) ?? num(current.window);
  if (!limit)
    return { status: "not-found", reason: "no-window" };
  const total = current.used;
  const omp = (breakdown?.categories ?? []).filter((category) => OMP_CATEGORIES.includes(category.id) && num(category.tokens) !== undefined);
  const categories = omp.length > 0 ? omp.map(({ id, tokens }) => ({ id, tokens })) : transcriptCategories(context);
  const buffer = num(breakdown?.autoCompactBufferTokens) ?? null;
  const threshold = num(breakdown?.thresholdTokens) ?? (buffer === null ? null : limit - buffer);
  const model = breakdown?.model?.provider && breakdown.model.modelId ? `${breakdown.model.provider}/${breakdown.model.modelId}` : null;
  const last = context.history.at(-1);
  return {
    status: "ok",
    model,
    limit,
    total,
    cacheRead: context.cache.lastTurnRead,
    cacheWrite: context.cache.lastTurnWrite,
    categories,
    categoriesFromOmp: omp.length > 0,
    history: context.history.slice(-HISTORY_POINTS).map((point) => point.used),
    compaction: {
      threshold,
      buffer,
      growth: averageGrowth(context.history.map((point) => point.used)),
      count: context.compactions.count,
      tokensBefore: num(context.compactions.tokensBefore) ?? null,
      tokensAfter: num(context.compactions.tokensAfter) ?? null
    },
    cache: { lastTurnAt: last && (last.cacheRead > 0 || last.cacheWrite > 0) ? last.at : null, ttlMs: CACHE_TTL_MS }
  };
}
function transcriptCategories({ current, history }) {
  if (!current)
    return [];
  const nonMessage = Math.min(current.nonMessage ?? 0, current.used);
  if (nonMessage === 0)
    return [{ id: "messages", tokens: current.used }];
  const toolSchema = Math.min(num(history.at(-1)?.toolSchema) ?? 0, nonMessage);
  return [
    { id: "system", tokens: nonMessage - toolSchema },
    ...toolSchema > 0 ? [{ id: "systemTools", tokens: toolSchema }] : [],
    { id: "messages", tokens: current.used - nonMessage }
  ];
}
function averageGrowth(used) {
  const recent = used.slice(-(GROWTH_WINDOW + 1));
  const deltas = recent.slice(1).map((value, index) => value - recent[index]).filter((delta) => delta > 0);
  if (deltas.length === 0)
    return null;
  return Math.round(deltas.reduce((total, delta) => total + delta, 0) / deltas.length);
}

// service/main.ts
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
var CONTEXT_PATH = "/context";
var notFound = (reason) => ({ status: "not-found", reason });
function sidecarUrl() {
  try {
    const dataDir = process.env.OPENCHAMBER_DATA_DIR || join(homedir(), ".config", "openchamber");
    const { url } = JSON.parse(readFileSync(join(dataDir, "omp-sidecar", "endpoint.json"), "utf8"));
    if (typeof url === "string" && url.startsWith("http://"))
      return url;
  } catch {}
  return "http://127.0.0.1:4096";
}
async function readContext(body) {
  let request;
  try {
    request = JSON.parse(body || "{}");
  } catch {
    return notFound("bad-request");
  }
  if (typeof request.sessionId !== "string" || request.sessionId === "")
    return notFound("no-session");
  let response;
  try {
    response = await fetch(`${sidecarUrl()}/api/omp/context/${encodeURIComponent(request.sessionId)}?breakdown=1`, { signal: AbortSignal.timeout(30000) });
  } catch {
    return notFound("unreachable");
  }
  if (response.status === 404)
    return notFound("session-not-found");
  if (!response.ok)
    return notFound("failed");
  return buildReport(await response.json());
}
http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/health") {
    res.writeHead(200).end("{}");
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    if (path !== CONTEXT_PATH || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    readContext(body).catch(() => notFound("failed")).then((report) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(report));
    });
  });
}).listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), "127.0.0.1");
