/**
 * Configuration surface: OpenChamber settings, OpenCode `/config`, commands,
 * skills, MCP and plugin config, and the stub catalogs (themes, snippets).
 */
import { handleOmpConfigRoute, listOmpSlashCommands } from "../adapters/openchamber/omp-config";
import { listAvailableSkills } from "../adapters/openchamber/discovery";
import { defaultBackend } from "../providers/registry";
import { apiOrGet, type RouteContext } from "../http/router";
import { readJson } from "../http/response";
import { clearProviderCache } from "../services/provider-cache";
import { readOmpConfig, writeOmpConfig } from "../services/settings-file";

function toV2ConfigEntries(directory: string): Array<{ type: "document"; path: string; info: Record<string, unknown> }> {
  const config = readOmpConfig(directory);
  const rawModel = config.model;
  let model: Record<string, unknown> | string | undefined;
  if (rawModel && typeof rawModel === "object" && !Array.isArray(rawModel)) {
    const value = rawModel as Record<string, unknown>;
    const providerID = typeof value.providerID === "string" ? value.providerID : "omp";
    const modelID = typeof value.model === "string" ? value.model : typeof value.modelID === "string" ? value.modelID : "omp";
    model = { providerID, model: modelID, ...(typeof value.variant === "string" ? { variant: value.variant } : {}) };
  } else if (typeof rawModel === "string") {
    const slash = rawModel.indexOf("/");
    model = slash > 0
      ? { providerID: rawModel.slice(0, slash), model: rawModel.slice(slash + 1) }
      : { providerID: "omp", model: rawModel };
  }
  const defaultAgent = typeof config.default_agent === "string"
    ? config.default_agent
    : typeof config.agent === "string" ? config.agent : "omp";
  return [{
    type: "document",
    path: "omp-sidecar",
    info: {
      default_agent: defaultAgent,
      ...(model !== undefined ? { model } : {}),
      // OpenChamber gates its todo panel on OpenCode's `experimental.todo` flag
      // and turns it off when the config says nothing. omp always has its todo
      // tool, so the sidecar says so explicitly instead of leaving it unset.
      experimental: { todo: defaultBackend().capabilities.todo },
    },
  }];
}

export async function handleConfig(ctx: RouteContext): Promise<Response | undefined> {
  const { req, url, path, p, dir, effectiveDir, json } = ctx;
  // Command metadata. omp owns its commands and exposes no file path for
  // them, so every entry reads as "defined by the backend" (`source:
  // none`), which is what OpenChamber shows for commands it did not write.
  const noCommandSource = { source: "none", scope: null, path: null, legacy: false, config: {} };
  if (path === "/api/config/command-configs" && req.method === "GET") {
    const names = url.searchParams.getAll("name").filter((name) => name.length > 0);
    return json({ commands: names.map((name) => ({ name, entry: noCommandSource })) });
  }
  const commandConfigMatch = path.match(/^\/api\/config\/commands\/([^/]+)\/config$/);
  if (commandConfigMatch && req.method === "GET") return json(noCommandSource);
  if (path.startsWith("/api/config/commands/")) {
    const cmdName = decodeURIComponent(path.slice("/api/config/commands/".length));
    return json({
      name: cmdName,
      sources: { md: { exists: false }, json: { exists: false } },
      scope: null,
      isBuiltIn: true,
    });
  }

  // OpenChamber settings and metadata routes
  if (path === "/api/config/settings") {
    if (req.method === "PUT" || req.method === "PATCH" || req.method === "POST") {
      const updates = (await readJson(req)) as Record<string, unknown> | undefined;
      const updated = writeOmpConfig(updates && typeof updates === "object" ? updates : {});
      return json(updated);
    }
    return json(readOmpConfig(effectiveDir));
  }

  // `/api/config/themes` answers any method with an empty list; the bare
  // `/config/themes` alias is GET-only and carries the current-theme shape.
  if (path === "/api/config/themes") {
    return json([]);
  }

  if ((p === "/config/snippets" || p.startsWith("/config/snippets/")) && apiOrGet(ctx)) {
    return json([]);
  }

  if (path.startsWith("/api/config/skills")) {
    return json([]);
  }

  if (path.startsWith("/api/config/mcp") || path === "/api/config/plugins" || path.startsWith("/api/config/plugins/")) {
    const configResponse = await handleOmpConfigRoute(req, url, path, effectiveDir);
    if (configResponse) return json(configResponse.data, { status: configResponse.status });
  }

  // Config
  if ((p === "/config" || p === "/global/config") && req.method === "GET") {
    return p === "/config"
      ? json(toV2ConfigEntries(effectiveDir))
      : json(readOmpConfig(effectiveDir));
  }

  if (
    (p === "/config" || p === "/global/config") &&
    (req.method === "PATCH" || req.method === "POST" || req.method === "PUT")
  ) {
    const updates = (await readJson(req)) as Record<string, unknown> | undefined;
    const updated = writeOmpConfig(updates && typeof updates === "object" ? updates : {});
    return json(updated);
  }

  // Commands
  if (p === "/command" && req.method === "GET") {
    const cmds = await listOmpSlashCommands(effectiveDir);
    return json({
      location: { directory: effectiveDir },
      data: cmds.map(({ name, description }) => ({ name, ...(description ? { description } : {}) })),
    });
  }

  // Skill
  if (p === "/skill" && req.method === "GET") {
    const skills = await listAvailableSkills(dir);
    const data = await Promise.all(skills.map(async (skill) => ({
      id: skill.name,
      name: skill.name,
      description: skill.description,
      path: skill.path,
      content: await Bun.file(skill.path).text().catch(() => ""),
    })));
    return json({ location: { directory: effectiveDir }, data });
  }

  // MCP
  if (p === "/mcp" && req.method === "GET") {
    return json({ location: { directory: effectiveDir }, data: [] });
  }

  // Config reload
  if (path === "/api/config/reload" || path === "/config/reload") {
    clearProviderCache();
    return json({ success: true });
  }

  if (path === "/config/themes" && req.method === "GET") {
    return json({ themes: [], currentTheme: "dark" });
  }

  if (p.startsWith("/config/skills/catalog") && req.method === "GET") {
    return json({ skills: [] });
  }

  if (p.startsWith("/config/mcp") && req.method === "GET") {
    return json([]);
  }

  return undefined;
}
