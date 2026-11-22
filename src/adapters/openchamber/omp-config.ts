/**
 * OpenChamber config surfaces (MCP servers, plugins, slash commands) backed by
 * omp's own state: `mcp.json` files, the `omp plugin` CLI and the RPC
 * `get_available_commands` command. Nothing here keeps a copy of that state.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getExplicitOmpBinary } from "../../providers/omp/binary";
import { Utility } from "../../omp/utility";
import { listAvailableCommands } from "./discovery";

type Json = Record<string, unknown>;
export type ConfigScope = "user" | "project";

export class ConfigError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const strMap = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
};

// ---------------------------------------------------------------- MCP

const MCP_NAME = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/;

function mcpPath(scope: ConfigScope, directory: string | undefined): string {
  if (scope === "project") {
    if (!directory) throw new ConfigError("Project scope requires working directory", 400);
    return join(directory, ".omp", "mcp.json");
  }
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"), "mcp.json");
}

function readMcpFile(path: string): Json {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
}

function writeMcpFile(path: string, config: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, "\t") + "\n");
}

/** omp server entry -> OpenChamber's v2 entity (`type: local|remote`, `command` as one array). */
function toOpenChamberMcp(raw: Json): Json {
  const url = str(raw.url);
  const remote = raw.type === "http" || raw.type === "sse" || (url !== undefined && raw.command === undefined);
  const disabled = raw.enabled === false;
  if (remote) {
    return {
      type: "remote",
      ...(url ? { url } : {}),
      ...(strMap(raw.headers) ? { headers: strMap(raw.headers) } : {}),
      ...(disabled ? { disabled: true } : {}),
    };
  }
  const head = str(raw.command);
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  return {
    type: "local",
    ...(head ? { command: [head, ...args] } : {}),
    ...(str(raw.cwd) ? { cwd: str(raw.cwd) } : {}),
    ...(strMap(raw.env) ? { environment: strMap(raw.env) } : {}),
    ...(disabled ? { disabled: true } : {}),
  };
}

/** OpenChamber entity -> omp entry, layered over `existing` so omp-only fields (auth, oauth, timeout, ...) survive. */
function toOmpMcp(entity: Json, existing: Json = {}): Json {
  const next: Json = { ...existing };
  const remote = entity.type === "remote";
  if (remote) {
    next.type = existing.type === "sse" ? "sse" : "http";
    delete next.command;
    delete next.args;
    delete next.env;
    const url = str(entity.url);
    if (url) next.url = url;
    const headers = strMap(entity.headers);
    if (headers) next.headers = headers;
    else delete next.headers;
  } else {
    next.type = "stdio";
    delete next.url;
    delete next.headers;
    const command = Array.isArray(entity.command) ? entity.command.map(String).filter(Boolean) : [];
    if (command.length === 0) throw new ConfigError("MCP command is required", 400);
    next.command = command[0];
    if (command.length > 1) next.args = command.slice(1);
    else delete next.args;
    const env = strMap(entity.environment);
    if (env) next.env = env;
    else delete next.env;
    const cwd = str(entity.cwd);
    if (cwd) next.cwd = cwd;
    else delete next.cwd;
  }
  if (typeof entity.disabled === "boolean") {
    if (entity.disabled) next.enabled = false;
    else delete next.enabled;
  }
  return next;
}

function mcpServers(config: Json): Json {
  return isRecord(config.mcpServers) ? config.mcpServers : {};
}

function mcpLayers(directory: string | undefined): Array<{ scope: ConfigScope; path: string; config: Json }> {
  const layers: Array<{ scope: ConfigScope; path: string; config: Json }> = [
    { scope: "user", path: mcpPath("user", directory), config: readMcpFile(mcpPath("user", directory)) },
  ];
  if (directory) {
    const path = mcpPath("project", directory);
    layers.push({ scope: "project", path, config: readMcpFile(path) });
  }
  return layers;
}

function findMcp(name: string, directory: string | undefined) {
  // Project entries shadow user entries, as in omp's own precedence.
  for (const layer of [...mcpLayers(directory)].reverse()) {
    const raw = mcpServers(layer.config)[name];
    if (isRecord(raw)) return { ...layer, raw };
  }
  return null;
}

function mcpEntry(name: string, layer: { scope: ConfigScope; raw: Json }): Json {
  return { name, ...toOpenChamberMcp(layer.raw), scope: layer.scope, sectionKey: "servers", legacy: false };
}

export function listMcpServers(directory: string | undefined): Json[] {
  const merged = new Map<string, { scope: ConfigScope; raw: Json }>();
  for (const layer of mcpLayers(directory)) {
    for (const [name, raw] of Object.entries(mcpServers(layer.config))) {
      if (isRecord(raw)) merged.set(name, { scope: layer.scope, raw });
    }
  }
  return [...merged].map(([name, layer]) => mcpEntry(name, layer));
}

export function getMcpServer(name: string, directory: string | undefined): Json | null {
  const found = findMcp(name, directory);
  return found ? mcpEntry(name, found) : null;
}

export function createMcpServer(name: string, body: Json, directory: string | undefined): { path: string } {
  if (!MCP_NAME.test(name)) throw new ConfigError("MCP server name must be lowercase alphanumeric with hyphens/underscores", 400);
  if (findMcp(name, directory)) throw new ConfigError(`MCP server "${name}" already exists`, 409);
  const scope: ConfigScope = body.scope === "project" ? "project" : "user";
  const path = mcpPath(scope, directory);
  const config = readMcpFile(path);
  config.mcpServers = { ...mcpServers(config), [name]: toOmpMcp(body) };
  writeMcpFile(path, config);
  return { path };
}

export function updateMcpServer(name: string, updates: Json, directory: string | undefined): { path: string } {
  const found = findMcp(name, directory);
  if (!found) throw new ConfigError(`MCP server "${name}" not found`, 404);
  const merged = { ...toOpenChamberMcp(found.raw), ...updates };
  delete merged.name;
  delete merged.scope;
  found.config.mcpServers = { ...mcpServers(found.config), [name]: toOmpMcp(merged, found.raw) };
  writeMcpFile(found.path, found.config);
  return { path: found.path };
}

export function deleteMcpServer(name: string, directory: string | undefined): { path: string } {
  const found = findMcp(name, directory);
  if (!found) throw new ConfigError(`MCP server "${name}" not found`, 404);
  const servers = { ...mcpServers(found.config) };
  delete servers[name];
  found.config.mcpServers = servers;
  writeMcpFile(found.path, found.config);
  return { path: found.path };
}

// ------------------------------------------------------------ plugins

interface OmpPluginRow {
  name: string;
  version?: string;
  path?: string;
  enabled?: boolean;
}

const pluginId = (name: string): string => Buffer.from(`config:user:${name}`).toString("base64url");

function pluginFromId(id: string): string {
  const decoded = Buffer.from(id, "base64url").toString("utf8");
  const match = /^config:user:(.+)$/.exec(decoded);
  if (!match) throw new ConfigError("Plugin entry not found", 404, "NOT_FOUND");
  return match[1]!;
}

async function runOmpCli(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const binary = getExplicitOmpBinary() ?? process.env.OMP_BIN ?? "omp";
  const proc = Bun.spawn([binary, ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

async function ompPluginAction(action: string, targets: string[], cwd?: string): Promise<void> {
  const result = await runOmpCli(["plugin", action, ...targets], cwd);
  if (result.code !== 0) {
    throw new ConfigError((result.stderr || result.stdout).trim().split("\n").slice(-3).join("\n") || `omp plugin ${action} failed`, 400);
  }
}

export async function listPlugins(): Promise<{ entries: Json[]; files: Json[] }> {
  const result = await runOmpCli(["plugin", "list", "--json"]);
  if (result.code !== 0) throw new ConfigError(result.stderr.trim() || "omp plugin list failed", 500);
  const parsed = JSON.parse(result.stdout) as { npm?: OmpPluginRow[] };
  const entries = (parsed.npm ?? []).map((plugin) => ({
    id: pluginId(plugin.name),
    spec: plugin.version ? `${plugin.name}@${plugin.version}` : plugin.name,
    scope: "user",
    kind: "config",
    parsedKind: "npm",
    sourcePath: plugin.path ?? "",
    legacy: false,
    policyResource: `plugin:${plugin.name}`,
    switchState: plugin.enabled === false ? "off" : "on",
  }));
  return { entries, files: [] };
}

export async function installPlugin(spec: unknown): Promise<void> {
  const value = str(spec);
  if (!value) throw new ConfigError("Plugin spec must be a non-empty string", 400, "INVALID_SPEC");
  await ompPluginAction("install", [value]);
}

export async function uninstallPlugin(id: string): Promise<void> {
  await ompPluginAction("uninstall", [pluginFromId(id)]);
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await ompPluginAction(enabled ? "enable" : "disable", [pluginFromId(id)]);
}

// ----------------------------------------------------- slash commands

export interface SlashCommand {
  name: string;
  description?: string;
}

const COMMAND_TTL_MS = 60_000;
const commandCache = new Map<string, { at: number; commands: SlashCommand[] }>();
const commandInflight = new Map<string, Promise<SlashCommand[]>>();

/**
 * Commands omp itself would accept in a session at `directory`: its builtins,
 * skills, file commands, MCP prompts and every plugin/extension command
 * (e.g. `/pi-vcc`). Cached because answering it costs one omp spawn.
 */
export async function listOmpSlashCommands(directory: string): Promise<SlashCommand[]> {
  const cached = commandCache.get(directory);
  if (cached && Date.now() - cached.at < COMMAND_TTL_MS) return cached.commands;
  const pending = commandInflight.get(directory);
  if (pending) return pending;
  const load = (async () => {
    try {
      const data = await Utility.for(directory).availableCommands() as { commands?: Array<{ name?: unknown; description?: unknown }> };
      const commands = (data?.commands ?? [])
        .filter((command): command is { name: string; description?: unknown } => typeof command.name === "string" && command.name.length > 0)
        .map((command) => ({ name: command.name, ...(typeof command.description === "string" && command.description ? { description: command.description } : {}) }));
      if (commands.length === 0) throw new Error("omp reported no commands");
      commandCache.set(directory, { at: Date.now(), commands });
      return commands;
    } catch {
      // omp unreachable: fall back to filesystem discovery rather than an empty palette.
      return (await listAvailableCommands(directory)).map(({ name, description }) => ({ name, description }));
    } finally {
      commandInflight.delete(directory);
    }
  })();
  commandInflight.set(directory, load);
  return load;
}

// -------------------------------------------------------------- routes

export interface ConfigRouteResult {
  status: number;
  data: unknown;
}

const applied = (message: string, details?: Json): ConfigRouteResult => ({
  status: 200,
  // New omp sessions read mcp.json / the plugin set at spawn; nothing to reload here.
  data: { success: true, message, requiresReload: false, ...details },
});

async function readBody(req: Request): Promise<Json> {
  try {
    const body = (await req.json()) as unknown;
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

/** `/api/config/mcp*` and `/api/config/plugins*`; null when the path is not one this module owns. */
export async function handleOmpConfigRoute(req: Request, url: URL, path: string, defaultDirectory: string): Promise<ConfigRouteResult | null> {
  const directory = url.searchParams.get("directory")?.trim() || defaultDirectory;
  try {
    const mcp = /^\/api\/config\/mcp(?:\/([^/]+))?$/.exec(path);
    if (mcp) {
      const name = mcp[1] ? decodeURIComponent(mcp[1]) : undefined;
      if (!name) return req.method === "GET" ? { status: 200, data: listMcpServers(directory) } : null;
      if (req.method === "GET") {
        const server = getMcpServer(name, directory);
        return server ? { status: 200, data: server } : { status: 404, data: { error: `MCP server "${name}" not found` } };
      }
      if (req.method === "POST") return applied(`MCP server "${name}" created.`, createMcpServer(name, await readBody(req), directory));
      if (req.method === "PATCH") return applied(`MCP server "${name}" updated.`, updateMcpServer(name, await readBody(req), directory));
      if (req.method === "DELETE") return applied(`MCP server "${name}" deleted.`, deleteMcpServer(name, directory));
      return null;
    }

    if (path === "/api/config/plugins" && req.method === "GET") return { status: 200, data: await listPlugins() };
    if (path === "/api/config/plugins/registry" && req.method === "GET") return { status: 200, data: { results: [] } };
    if (path === "/api/config/plugins/entry" && req.method === "POST") {
      await installPlugin((await readBody(req)).spec);
      commandCache.clear();
      return applied("Plugin entry created.");
    }
    const entry = /^\/api\/config\/plugins\/entry\/([^/]+)(\/enabled)?$/.exec(path);
    if (entry) {
      const id = decodeURIComponent(entry[1]!);
      if (entry[2] && req.method === "PUT") {
        const enabled = (await readBody(req)).enabled;
        if (typeof enabled !== "boolean") return { status: 400, data: { error: "enabled must be a boolean", code: "INVALID_STATE" } };
        await setPluginEnabled(id, enabled);
        commandCache.clear();
        return applied(`Plugin ${enabled ? "enabled" : "disabled"}.`);
      }
      if (!entry[2] && req.method === "DELETE") {
        await uninstallPlugin(id);
        commandCache.clear();
        return applied("Plugin entry deleted.");
      }
      if (!entry[2] && req.method === "PATCH") {
        return { status: 400, data: { error: "Reinstall the plugin with the new spec; omp pins versions at install time", code: "INVALID_SPEC" } };
      }
    }
    // Loose plugin files are an OpenCode concept; omp has none.
    if (path === "/api/config/plugins/file" || path.startsWith("/api/config/plugins/file/")) {
      return req.method === "GET" && path === "/api/config/plugins/file" ? { status: 200, data: [] } : { status: 404, data: { error: "Plugin file not found" } };
    }
    return null;
  } catch (error) {
    if (error instanceof ConfigError) return { status: error.status, data: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
    return { status: 500, data: { error: error instanceof Error ? error.message : "config request failed" } };
  }
}
