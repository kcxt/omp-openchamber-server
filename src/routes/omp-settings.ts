/** omp settings editor: page, script and JSON API (`panels/omp-settings.ts`). */
import { handleOmpSettingsRoute } from "../panels/omp-settings";
import type { RouteContext } from "../http/router";

export async function handleOmpSettings(ctx: RouteContext): Promise<Response | undefined> {
  const { req, path, cors, json } = ctx;
  if (path === "/api/omp/settings" || path.startsWith("/api/omp/settings/")) {
    const settingsResponse = await handleOmpSettingsRoute(req, path);
    if (settingsResponse?.html !== undefined) {
      return new Response(settingsResponse.html, { status: settingsResponse.status, headers: { ...cors, "content-type": "text/html; charset=utf-8" } });
    }
    if (settingsResponse?.script !== undefined) {
      return new Response(settingsResponse.script, { status: settingsResponse.status, headers: { ...cors, "content-type": "text/javascript; charset=utf-8" } });
    }
    if (settingsResponse) return json(settingsResponse.data, { status: settingsResponse.status });
  }

  return undefined;
}
