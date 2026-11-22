/** OpenChamber's settings file under the data dir; the single owner of its reads and writes. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureLegacyOmpConfigMigrated } from "../adapters/openchamber/small-model";
import { logger } from "../shared/logger";

export const openChamberDataDir = Bun.env.OPENCHAMBER_DATA_DIR
  || process.env.OPENCHAMBER_DATA_DIR
  || join(homedir(), ".config", "openchamber");

function getOpenChamberSettingsFile(): string {
  const dataDir = Bun.env.OPENCHAMBER_DATA_DIR
    || process.env.OPENCHAMBER_DATA_DIR
    || join(homedir(), ".config", "openchamber");
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "settings.json");
}

export function readOmpConfig(effectiveDir = process.cwd()): Record<string, unknown> {
  const home = Bun.env.HOME || process.env.HOME || "/tmp";
  let base: Record<string, unknown> = {
    model: "omp",
    agent: "omp",
    projects: [
      {
        id: "global",
        path: effectiveDir,
        label: "Project",
      },
    ],
    activeProjectId: "global",
    homeDirectory: home,
  };
  try {
    const file = getOpenChamberSettingsFile();
    ensureLegacyOmpConfigMigrated(file);
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") base = { ...base, ...parsed };
    }
  } catch {
    /* ignore */
  }
  return base;
}

export function writeOmpConfig(updates: Record<string, unknown>): Record<string, unknown> {
  const current = readOmpConfig();
  const merged = { ...current, ...updates };
  try {
    const file = getOpenChamberSettingsFile();
    writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  } catch (err) {
    logger.error({ err }, "failed to write settings");
  }
  return merged;
}
