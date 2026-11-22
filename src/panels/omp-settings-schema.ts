/**
 * The settings layout the editor renders.
 *
 * The committed snapshot (omp-settings-schema.json) is what ships. It is only
 * as current as the omp release it was generated from, so when the running
 * omp reports a different version the sidecar re-runs the generator against a
 * local omp source checkout and serves that instead, cached under the omp
 * agent dir. Without a checkout, or without bun to run the generator, the
 * snapshot stays and unknown keys still surface under "Advanced".
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getOmpRuntimeInfo, probeOmpVersion } from "../providers/omp/binary";
import staticSchema from "./omp-settings-schema.json";

type Schema = { ompVersion?: string };

const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
const cachePath = () => join(agentDir(), "openchamber-settings-schema.json");
const generatorPath = () => join(import.meta.dir, "..", "..", "scripts", "gen-omp-settings-schema.ts");

/** Candidate locations of an omp source checkout; OMP_SOURCE_DIR wins. */
function sourceCandidates(binary: string | null): string[] {
  const candidates = [process.env.OMP_SOURCE_DIR, join(homedir(), "git", "oh-my-pi")];
  if (binary) {
    // bun's global bin is a link into the checkout it was installed from.
    candidates.push(dirname(resolve(binary)));
  }
  return candidates.filter((path): path is string => typeof path === "string" && path.trim() !== "");
}

/** A checkout the generator can read its settings registry from. */
export function findOmpSourceDir(binary: string | null): string | null {
  for (const candidate of sourceCandidates(binary)) {
    for (const root of [candidate, dirname(candidate), dirname(dirname(candidate))]) {
      if (existsSync(join(root, "packages", "coding-agent", "src", "config", "all-settings.ts"))) return root;
    }
  }
  return null;
}

let cached: { schema: Schema; at: number } | undefined;
let regeneration: Promise<Schema | null> | null = null;
let lastError: string | null = null;

function readCache(): Schema | null {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8")) as Schema;
  } catch {
    return null;
  }
}

async function regenerate(binary: string | null): Promise<Schema | null> {
  const source = findOmpSourceDir(binary);
  if (!source) {
    lastError = "no omp source checkout found (set OMP_SOURCE_DIR)";
    return null;
  }
  try {
    const proc = Bun.spawn(["bun", generatorPath(), source, "--out", cachePath()], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (code !== 0) {
      lastError = (stderr || stdout).trim().split("\n").slice(-1)[0] || `generator exited ${code}`;
      return null;
    }
    mkdirSync(dirname(cachePath()), { recursive: true });
    const schema = readCache();
    lastError = null;
    if (!schema) {
      lastError = "generator wrote no readable schema";
      return null;
    }
    return schema;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

let probedVersion: string | null | undefined;

/**
 * The running omp's version. getOmpRuntimeInfo only knows it for the bundled
 * binary; anything else (a bun global link, OMP_BIN) needs one `omp --version`
 * probe, cached for the sidecar's lifetime.
 */
export async function runningOmpVersion(): Promise<string | null> {
  const runtime = getOmpRuntimeInfo();
  if (runtime.version) return runtime.version;
  if (probedVersion === undefined) {
    probedVersion = runtime.binary ? await probeOmpVersion(runtime.binary) : null;
  }
  return probedVersion;
}

/**
 * The layout to serve: a cache that matches the running omp, else the shipped
 * snapshot (kicking off a refresh in the background when it does not match).
 */
export async function loadSettingsSchema(): Promise<Schema> {
  const running = await runningOmpVersion();
  const cache = readCache();
  if (cache && running && cache.ompVersion === running) {
    cached = { schema: cache, at: Date.now() };
    return cache;
  }
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.schema;
  if (running && (cache?.ompVersion ?? staticSchema.ompVersion) !== running && !regeneration) {
    regeneration = regenerate(getOmpRuntimeInfo().binary).finally(() => { regeneration = null; });
  }
  return cache ?? staticSchema;
}

/** Force a refresh now, and report the outcome rather than the stale layout. */
export async function refreshSettingsSchema(): Promise<{ schema: Schema; refreshed: boolean; error?: string }> {
  const schema = await (regeneration ?? (regeneration = regenerate(getOmpRuntimeInfo().binary).finally(() => { regeneration = null; })));
  if (schema) {
    cached = { schema, at: Date.now() };
    return { schema, refreshed: true };
  }
  return { schema: readCache() ?? staticSchema, refreshed: false, error: lastError ?? "regeneration failed" };
}

/** What a background refresh is doing, for the editor's notice. */
export function schemaRefreshStatus(): { inFlight: boolean; error: string | null } {
  return { inFlight: regeneration !== null, error: lastError };
}
