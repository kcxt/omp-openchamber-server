/**
 * Where omp keeps sessions, and how it names the per-directory buckets.
 *
 * The bucket name has to match omp's own (`session-paths.ts` in oh-my-pi),
 * because a terminal omp and this sidecar share the directory:
 *   - `-<relative>`      for a cwd under $HOME,
 *   - `-tmp-<relative>`  for a cwd under the temp root (checked first),
 *   - `--<absolute>--`   for anything else,
 * with `/`, `\` and `:` turned into `-`, computed from the canonical (realpath)
 * cwd, so a symlinked project shares the bucket of its target.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

function home(): string {
  return Bun.env.HOME || process.env.HOME || "";
}

/** `$PI_CODING_AGENT_DIR`, else `~/.omp/agent`: the same root omp resolves. */
export function ompAgentDir(): string {
  const configured = Bun.env.PI_CODING_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? resolve(configured) : join(home(), ".omp", "agent");
}

export function ompSessionsRoot(): string {
  return join(ompAgentDir(), "sessions");
}

const realpaths = new Map<string, string>();

/** Symlink-free spelling of `path`; falls back to the lexical path when it does not exist. */
export function canonicalPath(path: string): string {
  const resolved = resolve(path);
  const cached = realpaths.get(resolved);
  if (cached !== undefined) return cached;
  let canonical = resolved;
  try {
    canonical = realpathSync(resolved);
  } catch {
    /* missing directory: keep the lexical path */
  }
  if (realpaths.size > 4096) realpaths.clear();
  realpaths.set(resolved, canonical);
  return canonical;
}

export function sameDirectory(a: string, b: string): boolean {
  return a === b || canonicalPath(a) === canonicalPath(b);
}

function within(rel: string): boolean {
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

function encodeRelative(prefix: string, rel: string): string {
  const encoded = rel.replace(/[/\\:]/g, "-");
  return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

/** omp's bucket name for `cwd`. */
export function encodeCwd(cwd: string): string {
  const canonical = canonicalPath(cwd);
  const homeRelative = relative(canonicalPath(home()), canonical);
  const tempRelative = relative(canonicalPath(tmpdir()), canonical);
  if (within(tempRelative)) return encodeRelative("-tmp", tempRelative);
  if (within(homeRelative)) return encodeRelative("-", homeRelative);
  return `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Older sidecar builds named non-home buckets `-<absolute>`; their sessions stay reachable. */
function legacyBucket(cwd: string): string {
  const resolved = resolve(cwd);
  const homePrefix = `${home()}/`;
  const path = resolved.startsWith(homePrefix) ? `/${resolved.slice(homePrefix.length)}` : resolved;
  return path.replace(/\//g, "-");
}

/** Every bucket that can hold sessions for `cwd`: omp's name for it as given and as resolved, plus the legacy one. */
export function sessionBucketNames(cwd: string): Set<string> {
  return new Set([encodeCwd(cwd), encodeCwd(resolve(cwd)), legacyBucket(cwd)]);
}

export function isSessionBucketOf(name: string, buckets: Set<string>): boolean {
  for (const bucket of buckets) {
    if (name === bucket || name.startsWith(`${bucket}.`)) return true;
  }
  return false;
}

/** The bucket directory name a session file sits in. */
export function bucketOfSessionPath(sessionPath: string): string {
  return relative(ompSessionsRoot(), sessionPath).split("/")[0] ?? "";
}
