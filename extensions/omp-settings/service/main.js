// service/src/main.js
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
var PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var SIDECAR = "http://127.0.0.1:4096";
var authorized = (header) => {
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  const given = Buffer.from(typeof header === "string" ? header : "");
  return TOKEN !== "" && given.length === expected.length && timingSafeEqual(given, expected);
};
var send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
var readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 1e6) {
      reject(new Error("body too large"));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});
var ROUTES = new Map([
  ["GET /settings", "/api/omp/settings"],
  ["PUT /settings", "/api/omp/settings"],
  ["POST /settings/reset", "/api/omp/settings/reset"]
]);
http.createServer(async (req, res) => {
  if (!authorized(req.headers.authorization))
    return send(res, 401, { error: "unauthorized" });
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (req.method === "GET" && path === "/health")
    return send(res, 200, { ok: true });
  const target = ROUTES.get(`${req.method} ${path}`);
  if (!target)
    return send(res, 404, { error: "not found" });
  try {
    const body = req.method === "GET" ? undefined : await readBody(req);
    const upstream = await fetch(SIDECAR + target, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(20000)
    });
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(await upstream.text());
  } catch (error) {
    send(res, 502, { error: `omp sidecar unreachable at ${SIDECAR}: ${error instanceof Error ? error.message : String(error)}` });
  }
}).listen(PORT, "127.0.0.1");
