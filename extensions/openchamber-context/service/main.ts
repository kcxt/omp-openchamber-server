import http from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildReport } from './breakdown';
import type { ContextReport, NotFoundReason, SidecarContext } from './breakdown';

const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
const CONTEXT_PATH = '/context';

type ContextRequest = { sessionId?: unknown };

const notFound = (reason: NotFoundReason): ContextReport => ({ status: 'not-found', reason });

// The service does not inherit the host environment: the sidecar publishes its address on start.
function sidecarUrl(): string {
  try {
    const dataDir = process.env.OPENCHAMBER_DATA_DIR || join(homedir(), '.config', 'openchamber');
    const { url } = JSON.parse(readFileSync(join(dataDir, 'omp-sidecar', 'endpoint.json'), 'utf8')) as { url?: unknown };
    if (typeof url === 'string' && url.startsWith('http://')) return url;
  } catch {
    // not published: fall back to the default port
  }
  return 'http://127.0.0.1:4096';
}

async function readContext(body: string): Promise<ContextReport> {
  let request: ContextRequest;
  try {
    request = JSON.parse(body || '{}') as ContextRequest;
  } catch {
    return notFound('bad-request');
  }
  if (typeof request.sessionId !== 'string' || request.sessionId === '') return notFound('no-session');

  let response: Response;
  try {
    response = await fetch(`${sidecarUrl()}/api/omp/context/${encodeURIComponent(request.sessionId)}?breakdown=1`, { signal: AbortSignal.timeout(30_000) });
  } catch {
    return notFound('unreachable');
  }
  if (response.status === 404) return notFound('session-not-found');
  if (!response.ok) return notFound('failed');
  return buildReport((await response.json()) as SidecarContext);
}

http
  .createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/health') {
      res.writeHead(200).end('{}');
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (path !== CONTEXT_PATH || req.method !== 'POST') {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
        return;
      }
      // readContext answers every problem with a note, so the page never sees a 500.
      readContext(body)
        .catch(() => notFound('failed'))
        .then((report) => {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(report));
        });
    });
  })
  .listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), '127.0.0.1');
