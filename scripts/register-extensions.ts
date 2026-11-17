#!/usr/bin/env bun
/**
 * Register this checkout's OpenChamber extensions (extensions/*) so they appear
 * in Settings -> Extensions without adding them by hand.
 *
 * OpenChamber keeps its folder installs as `{dataDir}/extensions.json`:
 * `{ "paths": [absolute folder, ...], "storageIds": {...} }`. A running
 * OpenChamber re-reads it within ~5 s and fills in missing storage ids itself,
 * so adding a path is all an install is; no server, login or API call needed.
 * Idempotent, and it leaves every other entry (and field) alone.
 *
 * Registering is not approving: an extension's local service still needs the
 * one-time "Allow" in Settings -> Extensions.
 *
 *   OPENCHAMBER_DATA_DIR   OpenChamber's data dir (default ~/.config/openchamber)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const repo = join(import.meta.dir, "..");
const dataDir = process.env.OPENCHAMBER_DATA_DIR || join(homedir(), ".config", "openchamber");
const file = join(dataDir, "extensions.json");

let store: Record<string, unknown> = {};
try {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) store = parsed as Record<string, unknown>;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    // A corrupt store is OpenChamber's to report; do not overwrite it.
    console.error(`register-extensions: ${file} is unreadable (${(error as Error).message}), leaving it alone`);
    process.exit(0);
  }
}

const paths = Array.isArray(store.paths) ? store.paths.filter((entry): entry is string => typeof entry === "string") : [];
const extensionsDir = join(repo, "extensions");
const added: string[] = [];
if (existsSync(extensionsDir)) {
  for (const name of readdirSync(extensionsDir).sort()) {
    const dir = join(extensionsDir, name);
    if (!existsSync(join(dir, "package.json"))) continue;
    // OpenChamber persists the realpath of a folder install.
    const real = realpathSync(dir);
    if (paths.includes(real)) continue;
    paths.push(real);
    added.push(name);
  }
}

if (added.length > 0) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...store, paths }, null, 2) + "\n");
  renameSync(temp, file);
  console.error(`register-extensions: registered ${added.join(", ")} (allow its service in Settings -> Extensions)`);
}
