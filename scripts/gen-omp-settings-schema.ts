#!/usr/bin/env bun
/**
 * Snapshot omp's settings layout (tabs, groups, labels, descriptions, option
 * lists, visibility conditions) from an omp source checkout, so the OpenChamber
 * settings editor can show the same screens as omp's own `/settings`.
 *
 *   bun scripts/gen-omp-settings-schema.ts [path/to/oh-my-pi]
 *
 * Writes src/adapters/openchamber/omp-settings-schema.json (override the
 * destination with --out <file>; the sidecar uses that to refresh its own
 * snapshot when the running omp's version no longer matches). Re-run it after
 * bumping the omp release; the editor shows a notice when the snapshot's omp
 * version differs from the running binary and files unknown keys under
 * "Advanced".
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? join(homedir(), "git", "oh-my-pi"));
const src = join(root, "packages", "coding-agent", "src");
const tuiDefs = join(root, "packages", "tui", "src", "overlays", "settings-defs");

const { orderedSettings } = await import(join(src, "config", "all-settings"));
const { SETTING_TABS, TAB_METADATA } = await import(tuiDefs);
const { cfgAdvisorEnabled } = await import(join(src, "advisor", "settings"));
const { cfgAutolearnEnabled } = await import(join(src, "autolearn", "settings"));
const { cfgMemoryBackend } = await import(join(src, "memory-backend", "settings"));
const { cfgTuiVimMode, cfgComposerPredictions } = await import(join(src, "modes", "settings"));
const { cfgPlanEnabled, cfgPlanAutosave } = await import(join(src, "plan-mode", "settings"));
const { cfgRetryUsageAwareFallback, cfgDefaultThinkingLevel } = await import(join(src, "session", "settings"));

type Clause = { id: string; eq: unknown } | { platform: string };

// The visibility conditions of omp's settings UI (src/config/settings-ui.ts),
// restated as "setting X equals Y" so a page can evaluate them from the values
// it already has. Terminal-capability conditions (image protocol, native
// rendering) and the "not project-supplied" ones always show here.
const CONDITIONS: Record<string, Clause[]> = {
  macOS: [{ platform: "darwin" }],
  advisorEnabled: [{ id: cfgAdvisorEnabled.id, eq: true }],
  vimModeEnabled: [{ id: cfgTuiVimMode.id, eq: true }],
  composerPredictionsEnabled: [{ id: cfgComposerPredictions.id, eq: true }],
  hindsightActive: [{ id: cfgMemoryBackend.id, eq: "hindsight" }],
  mnemopiActive: [{ id: cfgMemoryBackend.id, eq: "mnemopi" }],
  autolearnActive: [{ id: cfgAutolearnEnabled.id, eq: true }],
  autoThinkingActive: [{ id: cfgDefaultThinkingLevel.id, eq: "auto" }],
  usageAwareFallbackEnabled: [{ id: cfgRetryUsageAwareFallback.id, eq: true }],
  planModeEnabled: [{ id: cfgPlanEnabled.id, eq: true }],
  planAutosaveEnabled: [{ id: cfgPlanEnabled.id, eq: true }, { id: cfgPlanAutosave.id, eq: true }],
};

interface Option { value: string; label: string; description?: string }

const settings = [];
for (const tab of SETTING_TABS as string[]) {
  for (const setting of orderedSettings() as Iterable<any>) {
    const ui = setting.ui;
    if (ui?.tab !== tab) continue;
    const definition = setting.definition ?? setting;
    const options: Option[] | undefined = Array.isArray(ui.options)
      ? ui.options.map((option: Option) => ({ value: String(option.value), label: option.label, ...(option.description ? { description: option.description } : {}) }))
      : undefined;
    settings.push({
      id: setting.id,
      type: definition.type,
      ...(definition.default !== undefined ? { default: definition.default } : {}),
      ...(Array.isArray(definition.values) ? { values: definition.values } : {}),
      tab,
      group: ui.group,
      label: ui.label,
      description: ui.description ?? "",
      ...(options ? { options } : {}),
      ...(ui.condition && CONDITIONS[ui.condition] ? { condition: CONDITIONS[ui.condition] } : {}),
      ...(setting.isCredential ? { credential: true } : {}),
    });
  }
}

const version = JSON.parse(readFileSync(join(root, "packages", "coding-agent", "package.json"), "utf8")).version as string;
// Model roles (default, smol, slow, ...): the `modelRoles` record has no entry
// in the settings registry, omp edits it from its model browser, so the editor
// needs the role list and names to offer the same assignments.
const { MODEL_ROLES, MODEL_ROLE_IDS } = await import(join(src, "config", "model-roles"));
const roles = (MODEL_ROLE_IDS as string[])
  .filter((id) => !(MODEL_ROLES as Record<string, { hidden?: boolean }>)[id]!.hidden)
  .map((id) => {
    const info = (MODEL_ROLES as Record<string, { name: string; section: string }>)[id]!;
    return { id, name: info.name, section: info.section };
  });

// Built-in theme names for the two theme settings. getAvailableThemes also
// returns the generating machine's own themes (~/.omp/agent/themes), which are
// not part of omp; the sidecar lists the running machine's at request time.
const { getAvailableThemes } = await import(join(root, "packages", "tui", "src", "theme", "index"));
const customThemeDir = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"), "themes");
const customThemes = new Set(existsSync(customThemeDir) ? readdirSync(customThemeDir).map((file) => file.replace(/\.json$/, "")) : []);
const themes = ((await getAvailableThemes()) as string[]).filter((name) => !customThemes.has(name));

const out = {
  ompVersion: version,
  tabs: (SETTING_TABS as string[]).map((id) => ({ id, label: (TAB_METADATA as Record<string, { label: string }>)[id]!.label })),
  roles,
  themes,
  settings,
};
const outIndex = process.argv.indexOf("--out");
const target = outIndex > -1 && process.argv[outIndex + 1]
  ? resolve(process.argv[outIndex + 1]!)
  : join(import.meta.dir, "..", "src", "adapters", "openchamber", "omp-settings-schema.json");
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log(`${settings.length} settings in ${out.tabs.length} tabs (omp ${version}) -> ${target}`);
