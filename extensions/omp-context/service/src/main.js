// Local service for the omp context panel. It reads the session and its
// messages through the host's read-only OpenCode connection (the `opencode`
// role: `OPENCHAMBER_OPENCODE_URL` plus the service token), which here is the
// omp sidecar, and answers the panel with a reduced view (see summary.js). No
// filesystem access to omp's sessions, no hardcoded sidecar port.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { summarize } from './summary.js';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
const OPENCODE = process.env.OPENCHAMBER_OPENCODE_URL ?? '';
const SESSION_ID = /^ses_[A-Za-z0-9_-]+$/;

const authorized = (header) => {
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  const given = Buffer.from(typeof header === 'string' ? header : '');
  return TOKEN !== '' && given.length === expected.length && timingSafeEqual(given, expected);
};

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const read = async (path) => {
  const res = await fetch(OPENCODE + path, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`OpenCode answered ${res.status} for ${path}`);
  const body = await res.json();
  return body?.data ?? body;
};

http.createServer(async (req, res) => {
  if (!authorized(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'GET' || url.pathname !== '/context') return send(res, 404, { error: 'not found' });
  const sessionId = url.searchParams.get('sessionId') ?? '';
  if (!SESSION_ID.test(sessionId)) return send(res, 400, { error: 'sessionId must be an OpenCode session id' });
  if (!OPENCODE) return send(res, 503, { error: 'OpenCode access is unavailable: approve the opencode role for this extension' });
  try {
    const [session, messages] = await Promise.all([
      read(`/api/session/${sessionId}`),
      read(`/api/session/${sessionId}/message?limit=500`),
    ]);
    send(res, 200, summarize(session, messages));
  } catch (error) {
    send(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(PORT, '127.0.0.1');
