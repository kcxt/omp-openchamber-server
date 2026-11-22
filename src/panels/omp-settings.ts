/**
 * omp's own settings (`omp config`) over HTTP, plus a page to edit them.
 *
 * OpenChamber has no screen for omp settings, and its own server answers
 * `/api/config/*` itself, so this lives under `/api/omp/settings`: unmatched
 * `/api/*` paths are proxied to the sidecar by `openchamber serve`, so the page
 * opens at `<openchamber url>/api/omp/settings/ui` behind the same UI login.
 * The same view also ships as an OpenChamber extension panel
 * (extensions/omp-settings).
 *
 * The layout (tabs, groups, labels, option lists) is a snapshot of omp's own
 * settings registry (omp-settings-schema.json, from scripts/gen-omp-settings-schema.ts).
 */
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OmpCli } from "../omp/cli";
import { listOmpConfig, listOmpSetKeys, resetOmpConfigKey, setOmpConfigValue } from "../vendor/kabmo/config-cli";
import { loadSettingsSchema, refreshSettingsSchema, runningOmpVersion, schemaRefreshStatus } from "./omp-settings-schema";

export interface SettingsRouteResult {
  status: number;
  data?: unknown;
  html?: string;
  script?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

const fail = (error: unknown, status = 500): SettingsRouteResult => ({
  status,
  data: { error: error instanceof Error ? error.message : String(error) },
});

/** The running machine's own themes (~/.omp/agent/themes/*.json); omp's built-in names ship in the schema snapshot. */
function listCustomThemes(): string[] {
  try {
    return readdirSync(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"), "themes"))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

/** `provider/id` selectors omp can resolve, for the model pickers. Empty when omp cannot be asked. */
async function listModelSelectors(): Promise<Array<{ selector: string; name: string }>> {
  try {
    const { models } = await OmpCli.models();
    return models
      .filter((model) => typeof model.selector === "string" && model.selector.length > 0)
      .map((model) => ({ selector: model.selector, name: typeof model.name === "string" ? model.name : model.id }))
      .sort((a, b) => a.selector.localeCompare(b.selector));
  } catch {
    return [];
  }
}

export async function handleOmpSettingsRoute(req: Request, path: string): Promise<SettingsRouteResult | null> {
  if (path !== "/api/omp/settings" && !path.startsWith("/api/omp/settings/")) return null;

  if (path === "/api/omp/settings/ui" && req.method === "GET") return { status: 200, html: SETTINGS_PAGE };
  if (path === "/api/omp/settings/ui.js" && req.method === "GET") {
    const file = Bun.file(join(import.meta.dir, "omp-settings-view.js"));
    return (await file.exists()) ? { status: 200, script: await file.text() } : fail(new Error("settings view is not built (run `bun run build` in extensions/omp-settings)"), 500);
  }

  if (path === "/api/omp/settings" && req.method === "GET") {
    try {
      const [entries, set, models, layout, ompVersion] = await Promise.all([
        listOmpConfig(),
        listOmpSetKeys(),
        listModelSelectors(),
        loadSettingsSchema(),
        runningOmpVersion(),
      ]);
      const refresh = schemaRefreshStatus();
      return {
        status: 200,
        data: {
          entries,
          set,
          models,
          themes: listCustomThemes(),
          schema: layout,
          platform: process.platform,
          ompVersion,
          schemaRefresh: refresh.inFlight ? "in-flight" : refresh.error ? { error: refresh.error } : null,
        },
      };
    } catch (error) {
      return fail(error);
    }
  }

  if (path === "/api/omp/settings/schema/refresh" && req.method === "POST") {
    try {
      const [{ schema, refreshed, error }, ompVersion] = await Promise.all([refreshSettingsSchema(), runningOmpVersion()]);
      return { status: refreshed ? 200 : 503, data: { refreshed, schema, ompVersion, ...(error ? { error } : {}) } };
    } catch (error) {
      return fail(error);
    }
  }

  if (path === "/api/omp/settings" && (req.method === "PUT" || req.method === "POST")) {
    const body = await readBody(req);
    if (typeof body.key !== "string" || !body.key.trim()) return fail(new Error("key is required"), 400);
    const value = body.value;
    const typeOk = typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value) || isRecord(value);
    if (!typeOk) return fail(new Error("value must be a string, number, boolean, array, or record"), 400);
    try {
      return { status: 200, data: { success: true, key: body.key, value: (await setOmpConfigValue(body.key, value)) ?? null } };
    } catch (error) {
      // omp's own sentence for a rejected key or value is the useful part.
      return fail(error, 400);
    }
  }

  if (path === "/api/omp/settings/reset" && req.method === "POST") {
    const body = await readBody(req);
    if (typeof body.key !== "string" || !body.key.trim()) return fail(new Error("key is required"), 400);
    try {
      return { status: 200, data: { success: true, key: body.key, value: (await resetOmpConfigKey(body.key)) ?? null } };
    } catch (error) {
      return fail(error, 400);
    }
  }

  return null;
}

// The view is one script shared with the extension panel; this page only
// supplies a `call` that talks to these routes with the browser's own session.
const SETTINGS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>omp settings</title>
</head>
<body>
<script>window.__ompSettingsCall = async (method, path, body) => {
  const target = path === "/settings/reset" ? "/api/omp/settings/reset" : "/api/omp/settings";
  const res = await fetch(target, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};</script>
<script src="/api/omp/settings/ui.js"></script>
</body>
</html>`;
