/** Project helpers: nested repository discovery, project id encoding, empty project setup. */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// OpenChamber uses this bounded walk when a selected directory is not itself
// a Git repository. Keep the scan deliberately shallow and stop at repository
// boundaries: this is only for choosing a nested repo in the Git tab, not for
// indexing an entire filesystem.
const GIT_DIRS_MAX_DEPTH = 3;
const GIT_DIRS_MAX_DIRS = 100;
const GIT_DIRS_SKIP_NAMES = new Set(["node_modules", "dist", "build", ".venv", "target", ".next"]);

export async function findGitDirectories(rootPath: string): Promise<string[]> {
  const repositories: string[] = [];
  let visited = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (visited >= GIT_DIRS_MAX_DIRS) return;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      // A protected nested directory should not make the whole picker fail.
      // The root is handled by the route's error mapping below.
      if (directory === rootPath) throw err;
      return;
    }
    visited += 1;

    let isRepository = false;
    const subdirectories: string[] = [];
    for (const entry of entries) {
      // A .git directory, worktree pointer file, or symlink all identify a
      // repository boundary. Do not descend into that repository.
      if (entry.name === ".git") {
        isRepository = true;
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (GIT_DIRS_SKIP_NAMES.has(entry.name)) continue;
      if (depth >= GIT_DIRS_MAX_DEPTH) continue;
      subdirectories.push(entry.name);
    }

    if (isRepository) {
      if (directory !== rootPath) repositories.push(directory);
      return;
    }

    subdirectories.sort();
    for (const name of subdirectories) {
      if (visited >= GIT_DIRS_MAX_DIRS) break;
      await walk(join(directory, name), depth + 1);
    }
  };

  await walk(rootPath, 0);
  return repositories;
}

export function createProjectIdFromPath(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/g, "").trim();
  if (!normalized) return "";
  const data = new TextEncoder().encode(normalized);
  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `path_${encoded}`;
}

export function projectPathFromId(projectId: string): string | null {
  if (!projectId.startsWith("path_")) return null;
  const encoded = projectId.slice("path_".length);
  if (!encoded) return null;

  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

export function emptyProjectSetup(projectPath: string) {
  return {
    trust: { hash: null, trusted: true },
    setupWorktree: [],
    setupWorktreeWait: false,
    projectActions: [],
    projectActionsPrimaryId: null,
    draftStarters: [],
    shared: {
      status: "missing",
      path: join(projectPath, ".openchamber", "project.json"),
      setupWorktree: [],
      setupWorktreeWait: null,
      projectActions: [],
      draftStarters: [],
      plansDir: null,
    },
    personal: {
      setupWorktree: [],
      setupWorktreeWait: null,
      setupWorktreeMode: "append",
      projectActions: [],
      projectActionsPrimaryId: null,
      draftStarters: [],
      hiddenSharedActionIds: [],
      sharedTrust: null,
    },
  };
}
