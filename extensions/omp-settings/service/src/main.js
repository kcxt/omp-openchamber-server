// Local service for the omp settings panel. The panel cannot reach the omp
// sidecar itself (its iframe is sandboxed and `fetch` only sees package files),
// so the host proxies `serviceRequest` here and this process forwards it, over
// loopback, to the sidecar's `/api/omp/settings` routes. The sidecar owns the
// config files; nothing is written from this process.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
// The service does not inherit the host environment, so a non-default
// OC_SIDECAR_PORT cannot reach it. The sidecar publishes its address on start.
const sidecarUrl = () => {
  try {
    const dataDir = process.env.OPENCHAMBER_DATA_DIR || join(homedir(), '.config', 'openchamber');
    const { url } = JSON.parse(readFileSync(join(dataDir, 'omp-sidecar', 'endpoint.json'), 'utf8'));
    if (typeof url === 'string' && url.startsWith('http://')) return url;
  } catch { /* not published: fall back to the default port */ }
  return 'http://127.0.0.1:4096';
};

const authorized = (header) => {
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  const given = Buffer.from(typeof header === 'string' ? header : '');
  return TOKEN !== '' && given.length === expected.length && timingSafeEqual(given, expected);
};

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

// Panel path -> sidecar path. Anything else is refused: this is a bridge to the
// settings routes, not a general proxy.
const ROUTES = new Map([
  ['GET /settings', '/api/omp/settings'],
  ['PUT /settings', '/api/omp/settings'],
  ['POST /settings/reset', '/api/omp/settings/reset'],
]);

http.createServer(async (req, res) => {
  if (!authorized(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
  const target = ROUTES.get(`${req.method} ${path}`);
  if (!target) return send(res, 404, { error: 'not found' });
  const base = sidecarUrl();
  try {
    const body = req.method === 'GET' ? undefined : await readBody(req);
    const upstream = await fetch(base + target, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
  } catch (error) {
    send(res, 502, { error: `omp sidecar unreachable at ${base}: ${error instanceof Error ? error.message : String(error)}` });
  }
}).listen(PORT, '127.0.0.1');
