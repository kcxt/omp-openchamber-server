// service/main.ts
import http from "node:http";

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

// service/goal.ts
var GOAL_STATUSES = ["active", "paused", "complete", "budget-limited", "dropped"];
var finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
function buildGoalReport(answer) {
  const live = answer.live === true;
  const raw = answer.goal;
  if (!raw || typeof raw !== "object")
    return { status: "ok", live, goal: null };
  const { status, objective, tokensUsed, tokenBudget } = raw;
  if (!GOAL_STATUSES.includes(status))
    return { status: "ok", live, goal: null };
  const budget = finite(tokenBudget);
  return {
    status: "ok",
    live,
    goal: {
      status,
      objective: typeof objective === "string" ? objective : "",
      tokensUsed: finite(tokensUsed) ?? 0,
      tokenBudget: budget !== null && budget > 0 ? budget : null
    }
  };
}

// service/sidecar.ts
var asRecord = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
async function locateSidecar(sessionId) {
  const base = process.env.OPENCHAMBER_OPENCODE_URL;
  const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
  if (!base || !token)
    return { ok: false, reason: "unreachable" };
  let response;
  try {
    response = await fetch(`${base}/api/session/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(1e4)
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status === 404)
    return { ok: false, reason: "session-not-found" };
  if (!response.ok)
    return { ok: false, reason: "failed" };
  const body = asRecord(await response.json().catch(() => null));
  const session = asRecord(body?.data) ?? body;
  const url = asRecord(asRecord(session?.metadata)?.omp)?.sidecarUrl;
  if (typeof url !== "string" || !url.startsWith("http://"))
    return { ok: false, reason: "not-omp" };
  return { ok: true, url };
}

// service/tasks.ts
var TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"];
function buildTasksReport(answer) {
  const tasks = [];
  if (Array.isArray(answer.todos)) {
    for (const item of answer.todos) {
      if (!item || typeof item !== "object")
        continue;
      const { content, status } = item;
      if (typeof content !== "string" || content === "")
        continue;
      tasks.push({ content, status: TASK_STATUSES.includes(status) ? status : "pending" });
    }
  }
  return { status: "ok", tasks };
}

// service/main.ts
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
function parseRequest(body) {
  try {
    return JSON.parse(body || "{}");
  } catch {
    return null;
  }
}
async function readSidecar(body, route, timeoutMs, build) {
  const request = parseRequest(body);
  if (!request)
    return { status: "not-found", reason: "bad-request" };
  if (typeof request.sessionId !== "string" || request.sessionId === "")
    return { status: "not-found", reason: "no-session" };
  const located = await locateSidecar(request.sessionId);
  if (!located.ok)
    return { status: "not-found", reason: located.reason };
  const query = new URLSearchParams;
  if (typeof request.directory === "string" && request.directory !== "")
    query.set("directory", request.directory);
  let response;
  try {
    response = await fetch(`${located.url}${route(encodeURIComponent(request.sessionId), query)}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { status: "not-found", reason: "unreachable" };
  }
  if (response.status === 404)
    return { status: "not-found", reason: "session-not-found" };
  if (!response.ok)
    return { status: "not-found", reason: "failed" };
  return build(await response.json());
}
var withQuery = (path, query) => query.size > 0 ? `${path}?${query}` : path;
var HANDLERS = {
  "/context": (body) => readSidecar(body, (id, query) => {
    query.set("breakdown", "1");
    return withQuery(`/api/omp/context/${id}`, query);
  }, 30000, buildReport),
  "/goal": (body) => readSidecar(body, (id, query) => withQuery(`/api/omp/goal/${id}`, query), 1e4, buildGoalReport),
  "/tasks": (body) => readSidecar(body, (id, query) => withQuery(`/api/session-todos/${id}`, query), 1e4, buildTasksReport)
};
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
    const handler = req.method === "POST" && Object.hasOwn(HANDLERS, path) ? HANDLERS[path] : undefined;
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    handler(body).catch(() => ({ status: "not-found", reason: "failed" })).then((report) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(report));
    });
  });
}).listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), "127.0.0.1");
