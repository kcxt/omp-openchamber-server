/**
 * Request context and dispatch for the route table (`routes/index.ts`).
 *
 * Every route module exports one handler `(ctx) => Response | undefined`.
 * `dispatch` runs them in table order and the first handler that answers wins;
 * `undefined` falls through to the next module, then to the 404.
 */
import type { ClientAuthRuntime } from "../adapters/openchamber/client-auth";
import type { Responders } from "./response";

export interface RouteContext extends Responders {
  req: Request;
  url: URL;
  /** Raw pathname. */
  path: string;
  /** `path` with a leading `/api` removed: OpenCode core routes answer on both. */
  p: string;
  /** `?directory=` or `x-opencode-directory`; undefined when the client sent neither. */
  dir: string | undefined;
  /** `dir`, or the sidecar's cwd. */
  effectiveDir: string;
  cors: Record<string, string>;
  clientIp: string;
  clientAuth: ClientAuthRuntime;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response | undefined> | Response | undefined;

export function resolveOpenCodeDirectoryHeader(req: Request): string | undefined {
  const header = req.headers.get("x-opencode-directory");
  if (!header) return undefined;
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

export function normalizeApiPath(path: string): string {
  return path.startsWith("/api/") ? "/" + path.slice(5) : path;
}

/** `/api/x` answers any method; the bare `/x` alias answers GET only. */
export function apiOrGet(ctx: RouteContext): boolean {
  return ctx.path !== ctx.p || ctx.req.method === "GET";
}

export async function dispatch(table: readonly RouteHandler[], ctx: RouteContext): Promise<Response> {
  if (ctx.req.method === "OPTIONS") return new Response(null, { status: 204, headers: ctx.cors });
  for (const handler of table) {
    const response = await handler(ctx);
    if (response) return response;
  }
  return ctx.jsonError("not implemented", 404);
}
