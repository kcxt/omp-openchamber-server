import http from 'node:http';

import { buildReport } from './breakdown';
import type { ContextReport, SidecarContext } from './breakdown';
import { buildGoalReport } from './goal';
import type { GoalReport, SidecarGoal } from './goal';
import { locateSidecar } from './sidecar';
import type { SidecarReason } from './sidecar';
import { buildTasksReport } from './tasks';
import type { SidecarTodos, TasksReport } from './tasks';

const token = process.env.OPENCHAMBER_SERVICE_TOKEN;

type SessionRequest = { sessionId?: unknown; directory?: unknown };
type NotFound = { status: 'not-found'; reason: SidecarReason };

function parseRequest(body: string): SessionRequest | null {
  try {
    return JSON.parse(body || '{}') as SessionRequest;
  } catch {
    return null;
  }
}

/**
 * One sidecar read for the open session: locate the sidecar through the host, GET `route`, build the
 * report. Every problem is a `not-found` note, so the page never sees a 500.
 */
async function readSidecar<Report, Answer>(
  body: string,
  route: (sessionId: string, query: URLSearchParams) => string,
  timeoutMs: number,
  build: (answer: Answer) => Report,
): Promise<Report | NotFound> {
  const request = parseRequest(body);
  if (!request) return { status: 'not-found', reason: 'bad-request' };
  if (typeof request.sessionId !== 'string' || request.sessionId === '') return { status: 'not-found', reason: 'no-session' };

  const located = await locateSidecar(request.sessionId);
  if (!located.ok) return { status: 'not-found', reason: located.reason };

  const query = new URLSearchParams();
  if (typeof request.directory === 'string' && request.directory !== '') query.set('directory', request.directory);
  let response: Response;
  try {
    response = await fetch(`${located.url}${route(encodeURIComponent(request.sessionId), query)}`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { status: 'not-found', reason: 'unreachable' };
  }
  if (response.status === 404) return { status: 'not-found', reason: 'session-not-found' };
  if (!response.ok) return { status: 'not-found', reason: 'failed' };
  return build((await response.json()) as Answer);
}

const withQuery = (path: string, query: URLSearchParams): string => (query.size > 0 ? `${path}?${query}` : path);

const HANDLERS: Record<string, (body: string) => Promise<unknown>> = {
  '/context': (body) =>
    readSidecar<ContextReport, SidecarContext>(
      body,
      (id, query) => {
        query.set('breakdown', '1');
        return withQuery(`/api/omp/context/${id}`, query);
      },
      30_000,
      buildReport,
    ),
  '/goal': (body) => readSidecar<GoalReport, SidecarGoal>(body, (id, query) => withQuery(`/api/omp/goal/${id}`, query), 10_000, buildGoalReport),
  '/tasks': (body) => readSidecar<TasksReport, SidecarTodos>(body, (id, query) => withQuery(`/api/session-todos/${id}`, query), 10_000, buildTasksReport),
};

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
      const handler = req.method === 'POST' && Object.hasOwn(HANDLERS, path) ? HANDLERS[path] : undefined;
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
        return;
      }
      handler(body)
        .catch((): NotFound => ({ status: 'not-found', reason: 'failed' }))
        .then((report) => {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(report));
        });
    });
  })
  .listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), '127.0.0.1');
