Context-map wiring (openchamber-context) + sidecar architecture notes
Sources read: oh-my-pi `dca23990ad12` (~/git/oh-my-pi), openchamber `115e09d65605` (~/git/openchamber), MltStephane/openchamber-context v1.0.1 (/tmp/ctx-ext). Code-reading only — no panel was run against the sidecar.

**Status after the rewrite (Phase 4):** findings 2, 3, 5, 6, 7, 8 and 9 are resolved (one `Status:` line each below); 1 is resolved for the `opencode`-role panel; 4, 10 and 11 are reference notes; 12 is partly done. Paths below that named `src/providers/…` now live under `src/omp/` and `src/store/`.

FINDINGS

1. the extension cannot see omp sessions at all
`service/main.ts:54` tries `readClaudeCodeSession` then `readOpenCodeSession`: `~/.claude/projects/<cwd>/*.jsonl` and `~/.local/share/opencode/opencode.db`. omp writes `$PI_CODING_AGENT_DIR/sessions/<bucket>/<ts>_<uuid>.jsonl` (src/providers/omp/paths.ts). Against this sidecar the panel answers `{status:'not-found',reason:'no-data'}`. Its `ses_…` id lookup would also need the sidecar's id codec plus the transcript header's `openCodeId` (src/providers/omp/store.ts:932 `getOmpSessionByOpenCodeId` scans every bucket for it).
Status: resolved, differently. The context tab is now `extensions/openchamber-context` (vendored upstream, adapted); it asks the sidecar's `GET /api/omp/context/:id?breakdown=1` through `<data dir>/omp-sidecar/endpoint.json`, so it needs no filesystem access and no `opencode` role. Id lookup is `getOmpSessionByOpenCodeId` in `src/store/sessions.ts`; the session directory layout is `src/omp/paths.ts`.

2. omp's context map is not exposed out-of-process
- `ContextBreakdown` (packages/tui/src/status-line/context-usage.ts:68): categories systemPrompt/systemTools/systemContext/instructionFiles/skills/messages + usedTokens, contextWindow, thresholdTokens, autoCompactBufferTokens, freeTokens, snapcompact. In-process only.
- `ContextViewData` (packages/tui/src/chrome/context-view-model.ts:78, built by packages/coding-agent/src/session/context-view.ts:422): 10 categories with per-item entries (label, path, tokens, callId, timestamp, thinking groups). Only reachable as the `/context` TUI overlay (modes/controllers/command-controller.ts:996).
- RPC `get_state`/`get_session_stats` carry `contextUsage` = `{tokens, contextWindow, percent}` only (modes/rpc/rpc-types.ts:215, wire/state.ts:143, agent-session-types.ts:631). Collab ships the same two numbers (collab/host.ts:1289).
- `history.db` has no per-turn context table (agent-storage.ts:282: model_usage, model_perf, command_usage…).
- The transcript does: every settled assistant entry carries `usage` plus `contextSnapshot{promptTokens,nonMessageTokens,toolSchemaTokens,historyRewriteTokensRemoved,compactionEpoch}` (packages/ai/src/types.ts:1290); anchor trust rules packages/agent/src/compaction/transcript-tokens.ts:43; `correctedPromptTokens` packages/coding-agent/src/session/session-stats.ts:55. Provider-reported truth, readable offline.
- Model windows: `~/.omp/agent/models.db` `model_cache` (packages/catalog/src/model-cache.ts:246, packages/utils/src/dirs.ts:991). Compaction policy: `<agentDir>/config.yml` and `<project>/.omp/config.yml` (packages/coding-agent/src/config/settings.ts:1405,2697), `resolveThresholdTokens` packages/agent/src/compaction/compaction.ts:394.
Status: resolved. The patched omp serves `get_context_breakdown` over RPC and `omp session inspect --json` (P6); the sidecar uses both (`src/omp/cli.ts`, `src/adapters/openchamber/omp-context.ts`).

3. `/context` already answers over RPC, and the sidecar throws it away
RPC prompt dispatch runs builtin slash commands with `output: text => output({type:"command_output", text})` (modes/rpc/rpc-mode.ts:1953, wire/frames.ts:134); `/context`'s text comes from slash-commands/helpers/context-report.ts (categories, auto-compact buffer, free, snapcompact savings). `command_output` has no handler in src/providers/omp/events.ts — it is dropped today.
Status: resolved. `command_output` frames are handled in `src/sessions/turn-translator.ts` (and captured by the runtime for `/move`); a command that starts no turn answers with its text.

4. OpenChamber already has a sanctioned read seam to the sidecar
`contributes.service.provides: ["opencode"]` gives the service `OPENCHAMBER_OPENCODE_URL` + the service bearer, pointed at the OpenCode the host is connected to — here the sidecar (packages/sdk/GUEST_SERVICES.md:149,613; packages/web/server/lib/opencode/network-runtime.js:83 `buildOpenCodeUrl`). Allowlist is fixed and closed (packages/web/server/lib/guests/opencode-provider/index.ts:37): `/api/project`, `/api/session`, `/api/session/active`, `/api/session/ses_*`, `/api/session/ses_*/message`, `/api/session/ses_*/message/msg_*`, `/api/event`; anything else is 403 `NOT_A_LISTED_READ`. `contributes.sessionEvents` (`turn-finished`, `turn-started`, …) is the sanctioned push trigger (`POST /session-events`). The sidecar already writes per-message `metadata.omp` (src/providers/omp/messages.ts:1177) and passes it through to the v2 shape (src/adapters/openchamber/v2.ts:177), and per-session omp state into `metadata.openchamber` (src/providers/omp/recap.ts).

SUGGESTIONS

5. publish omp's context numbers onto the routes guests are allowed to read (sidecar-only work, do this first)
Per assistant turn add `metadata.omp.context = {used, window, categories, threshold, cacheRead, cacheWrite, at}` next to the existing `turnUsage`; per session add `metadata.openchamber.context = {used, window, categories, threshold, updatedAt}` beside `assist`. Tier 1 values come straight from the transcript's `usage`/`contextSnapshot` — no re-estimation, and strictly better than the extension's 4-chars-per-token split (service/breakdown.ts:76). Then any extension with the `opencode` role reads the whole history curve from `/api/session/:id/message` with no filesystem access, no hardcoded port, and it still works when the sidecar runs on another machine.
Status: done. `metadata.omp.context` per assistant message and `metadata.openchamber.context` per session are published (`src/omp/context.ts`, `src/adapters/openchamber/omp-context.ts`).

6. stop dropping `command_output`, but treat its text as interim
Capture the frame in src/providers/omp/events.ts and expose it. Parsing `/context`'s text (labels "System prompt", "System tools", "System context", "Instruction files", "Skills", "Messages", "Auto-compact buf", "Free") yields omp's own category numbers with zero upstream change, but the format is display text with ASCII bars — label it interim and keep the parser in one place so an omp wording change fails loudly instead of silently returning zeros.
Status: moot. The `/context` text is not parsed; the machine-readable `get_context_breakdown` (finding 7) supplies the categories.

7. upstream a machine-readable breakdown to omp (small PR against the existing wire DSL)
Add `get_context_breakdown` to packages/coding-agent/src/modes/rpc/wire/commands.ts + the `ContextBreakdownView` definition in wire/state.ts; the handler is `computeSessionContextBreakdown(session,{snapcompactSavings:true})` — the same call command-controller.ts:1003 uses — with `Model` narrowed to `{provider, modelId, contextWindow}`. Add `get_context_view` later for `buildSessionContextView`, with an `includeText:false` option: `ContextViewEntry.text` holds full entry text and would otherwise ship the transcript back out. This is the only faithful way to get per-skill / per-MCP / per-tool-item attribution; a plain omp extension cannot compute it (ExtensionContext exposes only `getContextUsage()` and `getSystemPrompt()`, docs/extensions.md:379).
Status: done on omp's `local` branch (`get_context_breakdown`, with `ContextBreakdownView` defined in `context-usage-runtime.ts`); not upstreamed. `get_context_view` (per-item attribution) is not built.

8. add the sidecar-native route for our own panels
`GET /api/omp/context/:sessionId?directory=` mirroring `/api/omp/settings`, returning a versioned `{breakdown, history, cache, subagents, unused}`. Tier 1 fills it immediately; the omp command from (7) upgrades the categories and items without changing this contract.
Status: done. `GET /api/omp/context/:sessionId?breakdown=1` (`src/routes/transcript.ts`).

9. extension-side change is a small third source, not a rewrite
`service/omp.ts` selected when `OPENCHAMBER_OPENCODE_URL` is present: read `/api/session/:id` + `/api/session/:id/message`, take `metadata.omp.context` / `metadata.openchamber.context`, subscribe `contributes.sessionEvents: {events:["turn-finished"]}` instead of the current "refresh when the session changes" guesswork, and keep the Claude/OpenCode readers otherwise. Also fixes the extension's unstated assumption that session files sit next to OpenChamber.
Status: superseded. The published fields are still served; the vendored `extensions/openchamber-context` reads the equivalent `GET /api/omp/context/:id` instead of the `opencode` role.

10. panel features map to three tiers, and only tier 1 is free today
- tier 1 (no upstream change): window bar, total, history curve, compaction threshold + growth, cache warm/expiry, largest items, subagents, message-kind split. Cache TTL is not recorded by omp; the extension's 5-min assumption stays flagged as an assumption.
- tier 2 (omp PR 7): category legend.
- tier 3 (omp PR 7, `get_context_view`): per-skill/per-MCP items, "loaded for nothing", per-tool-call/per-output items.

11. do NOT rip the extension host out of OpenChamber
The guest platform is ~28 routes (`/api/guests{,/upload,/:id,/:id/{capabilities,enabled,files,frame-grant,generate,mentions/*,oauth/*,opencode-plugin/global-config,request,service/*,settings,storage,token,update},/updates/check,/marks,/logos/*,/:id/{*filePath}}`, `/api/guest-files/:grant/{*filePath}`) plus spawn/token/ephemeral-port/idle-10min/keepRunning/schedule, capability grants and re-approval on manifest change, sessionEvents push, marks, surface viewer, and the roles browser/source-control/notifications/tracker/quota/opencode. Taking it over means owning a fork of a subsystem whose contract moves every few releases (marks shipped after 2.7.0; the opencode role and sessionEvents are 2.7-era), breaks invariant 1 of docs/architecture.md ("Zero Upstream Modifications"), and deletes the very seam (4, 9) this panel needs. Panels only render inside OpenChamber's rail via `connectHost` anyway, and VS Code / hosted + Capacitor mobile refuse guests entirely. The sidecar answers `GET /api/guests` with `{guests: []}` today (src/server.ts:721) because it has none of this.

12. what is worth changing structurally instead
- shrink the shadowing, not the host: `openchamber serve` answers `/api/config/mcp` and `/api/config/plugins` itself and writes `~/.config/opencode/opencode.json`, which is why the README marks them real only in Remote-Instances mode. The guest `opencode` role is unaffected — it dials the OpenCode connection, which is the sidecar.
- fix the version lie: `/api/info` advertises OpenChamber 2.0.14 while the installed host is 2.7.2 and this extension declares `engines.openchamber >= 2.7.0`. Any guest-feature gating on the advertised version misfires.
- kill the hardcoded sidecar address: extensions/omp-settings/service/main.js hardcodes `http://127.0.0.1:4096` because guest services inherit no host env, so a non-default `OC_SIDECAR_PORT` 502s the panel. Read-only needs are solved by `OPENCHAMBER_OPENCODE_URL`; anything that writes (the settings editor) needs a sidecar-issued callback URL handed to the service at spawn.
- adopt one publishing convention: omp-derived state reaches OpenChamber through `metadata.omp` (per message), `metadata.openchamber` (per session), and `sessionEvents` (push). Already true for title, recap, todos, revert markers, aliases; the context map is the same pattern, and it makes later panels (cost, cache weight, tool-output weight) nearly free.
Status: partly done. The sidecar writes `<data dir>/omp-sidecar/endpoint.json` and the settings extension reads it (`extensions/omp-settings/service/main.js`; it falls back to `127.0.0.1:4096` only when the file is missing). Open: `/api/info` still advertises OpenChamber 2.0.14 (`OPENCHAMBER_API_VERSION` in `src/routes/platform.ts`) while the installed host is newer.

UNVERIFIED

- whether OpenChamber's rail renders a guest catalog served by a non-OpenChamber server: the UI fetches `/api/guests` through its ordinary runtime base (packages/ui/src/lib/guests/load-catalog.ts:49), which suggests yes, but it was not proven. Only matters for a sidecar-hosted-guests plan (11), which is rejected anyway.
- nothing here was run end to end; all claims are from source reading.
