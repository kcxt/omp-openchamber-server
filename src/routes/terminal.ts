/** Terminal shells and lifecycle over HTTP. The WebSocket data plane is upgraded in `server.ts`. */
import type { RouteContext } from "../http/router";
import { terminalRuntime } from "../services/instances";

export async function handleTerminal(ctx: RouteContext): Promise<Response | undefined> {
  const terminalResponse = await terminalRuntime.handleHttp(ctx.req, ctx.url, ctx.path);
  if (terminalResponse) return ctx.json(terminalResponse.data, { status: terminalResponse.status });
  return undefined;
}
