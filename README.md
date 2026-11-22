# omp-openchamber-server

HTTP/SSE sidecar that lets [OpenChamber](https://github.com/OpenChamber/OpenChamber) drive [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) sessions. It speaks the OpenCode v2 API; neither project is modified.

## Run

```bash
bun install
bun run src/main.ts                 # http://127.0.0.1:4096
bun run src/main.ts --binary /path/to/omp --host 100.x.y.z --port 4096
```

| Option | Env | Default |
|---|---|---|
| `-b, --binary` (`--omp-bin`) | `OMP_BIN` | pinned release staged in `resources/omp` (`bun run prepare:omp`) |
| `-p, --port` | `OC_SIDECAR_PORT` | `4096` |
| `--host` | `OC_SIDECAR_HOST` | `127.0.0.1` |
| — | `LOG_LEVEL` | `info` (`debug` = access log) |

Connect: OpenChamber → **Settings → Remote Instances → Add server** → `http://127.0.0.1:4096`. Or `OPENCODE_HOST=http://127.0.0.1:4096 OPENCODE_SKIP_START=true openchamber serve --foreground`.

### systemd user service

```bash
./install.sh && systemctl --user daemon-reload && systemctl --user enable --now openchamber.service
```

With the two units, `openchamber.service` is the network-facing web UI (Tailscale address, needs `OPENCHAMBER_UI_PASSWORD` in `~/.config/omp-openchamber-server/env`, otherwise it binds `127.0.0.1`) and `omp-server.service` is its loopback backend. Both are sandboxed (`ProtectSystem=strict`, `ProtectHome=tmpfs`, explicit `BindPaths=`); edit them for your layout. Update = `git pull && systemctl --user restart omp-server openchamber`.

Caller-owned provider credentials: see [`docs/providers.md`](./docs/providers.md).

## OpenChamber feature status

**Real** = backed by omp, git, or the filesystem. **Sidecar** = implemented in the sidecar, omp unaware. **Stub** = fixed empty/disabled response; writes are accepted and discarded.

### Settings: do they reach omp?

| OpenChamber setting | Where it goes | Reaches omp? |
|---|---|---|
| Model / thinking variant picker (per prompt) | prompt body → omp RPC set-model | **Yes** |
| Model / agent switch on a session (`/session/:id/model`, `/agent`) | stored in the omp session transcript | **Yes** (used next turn) |
| Provider list / model catalog | read from omp's configured providers | **Yes** (read-only; add keys in omp) |
| `AGENTS.md` editor (Behavior) | writes `<project>/AGENTS.md` | **Yes** (omp reads it) |
| Small model (`smallModelOverride`, `smallModelVariant`, `smallModelUseDefault`) — used by **Goals** progress checks, titles, commit/PR text | `settings.json` picks the model; generation runs through `omp -p` on it. Default: omp `modelRoles.smol`, then `tiny`, then the session's model | **Yes** (model runs in omp; the setting itself lives in `settings.json`) |
| Permission auto-accept (global and per session) | sidecar approval policy | Sidecar only |
| Session archive / viewed marker | appended to the omp session JSONL | Persisted with the session |
| All other `PUT/PATCH /api/config/settings`, `/config`, `/global/config` | merged into `~/.config/openchamber/settings.json` and echoed back | **No** (stored only) |
| Skills / snippets / themes / custom-command editors | fixed empty lists | **No** (stub) |
| MCP server and plugin editors | `mcp.json` / `omp plugin` | **Yes** |
| Magic prompts, agent memory | empty | **No** (stub) |

### Features

| Area | Status |
|---|---|
| Sessions: create (client-minted ids), list, rename, archive, fork, children, revert/unrevert, compact, abort, todo, diff, move, view | Real |
| Prompts, `prompt_async`, shell, generate | Real |
| Slash commands (`/command`): omp's own list incl. plugin commands such as `/pi-vcc`; run by sending `/name args` as the prompt | Real (falls back to file discovery if omp can't start) |
| MCP servers (`/api/config/mcp`): read/write `~/.omp/agent/mcp.json` (user) and `<project>/.omp/mcp.json` (project); omp-only fields preserved | Real **only when the UI talks to the sidecar directly** (Remote Instances). Behind `openchamber serve`, OpenChamber answers this route itself and writes `~/.config/opencode/opencode.json`, which omp also reads as an MCP source |
| Plugins (`/api/config/plugins`): `omp plugin list/install/uninstall/enable/disable`; spec edit and npm-registry lookup unsupported | Real **only when the UI talks to the sidecar directly**. Behind `openchamber serve`, the Plugins page lists OpenCode plugin config, not omp plugins |
| omp settings (`omp config`): editor laid out like omp's own `/settings` (tabs, groups, readable names, dropdowns with option descriptions, model pickers, per-role model assignments, conditional rows); anything not in omp's layout is under Advanced. JSON at `/api/omp/settings`, standalone page at `/api/omp/settings/ui` (OpenChamber blocks framing it, so it cannot be embedded), and a rail panel shipped as an OpenChamber extension in [`extensions/omp-settings`](./extensions/omp-settings) | Real. `install.sh` and `bin/openchamber-serve` register the panel (`bin/register-extensions` adds it to OpenChamber's `extensions.json`); allow its local service once in Settings → Extensions. The service finds the sidecar through `<data dir>/omp-sidecar/endpoint.json`, which the sidecar writes at start (services do not inherit the environment), and falls back to `127.0.0.1:4096`. The layout is a snapshot of omp 18.19.0 (`bun scripts/gen-omp-settings-schema.ts` regenerates it after an omp bump). The sidecar refreshes it itself when the running omp reports another version: it re-runs the generator against a local omp checkout (`OMP_SOURCE_DIR`, `~/git/oh-my-pi`, or the checkout the `omp` binary links into) and caches the result at `<agent dir>/openchamber-settings-schema.json`; with no checkout it keeps the snapshot and the panel says so. Bridge vendored from [Kabmo](https://github.com/kabmo-labs/kabmo) (MIT, `src/vendor/kabmo`) |
| Session recap: OpenChamber's recap slot (`metadata.openchamber.assist`) filled from omp's own idle recap (`recap.*`, journaled to `session_recaps` in `~/.omp/agent/history.db`), skipped while OpenChamber's `sessionRecapEnabled` is off or its own assist already exists | Real **with an omp change**: omp's idle maintenance is opted in by interactive mode only, so `modes/rpc/rpc-mode.ts` must call `enableIdleMaintenance()` for RPC sessions (local patch in `~/git/oh-my-pi`, uncommitted). OpenChamber's own Small Model recap deliberately skips a session whose model is a local endpoint, which is why an omp-backed session shows no recap otherwise |
| omp context map: per-assistant-message `metadata.omp.context` (prompt tokens, window, non-message share, cache read/write) read from the transcript's `usage`/`contextSnapshot`, `metadata.openchamber.context` on `GET /session/:id`, and `GET /api/omp/context/:sessionId` (history curve, cache, compactions; `?breakdown=1` adds omp's category totals from RPC `get_context_breakdown`, `null` on an omp without it). Rail panel in [`extensions/omp-context`](./extensions/omp-context), which reads those fields through the host's `opencode` role (`OPENCHAMBER_OPENCODE_URL`) | Real for the transcript figures; the window shows once the sidecar has listed models. Categories need the omp patch adding `get_context_breakdown` (local, `~/git/oh-my-pi`) |
| Streaming (SSE + WebSocket events), tool parts, subagents, images | Real |
| Permissions, questions, forms | Real |
| Message queue / inbox (list, reorder, hold, take, delete) | Real; switching a queued item's delivery mode returns 409 |
| Git panel (status, diff, commit, branch, worktree, stash, log, identity, PR text) | Real (local `git`) |
| Source-control binding | Sidecar: always reports repo with no hosted-forge binding |
| File browser / read / write / rename / delete / clone / stat / directory availability | Real |
| Project context | Real |
| Browser control (`openchamber_web` extension) | Real |
| `/api/info`, `/api/version`, health | Sidecar (advertises OpenCode API 2.2.4, OpenChamber 2.0.14) |
| Session folders, project icons, spaces archives, received pages | Stub (empty) |
| GitHub / Linear auth | Stub (`not authenticated/connected`) |
| Usage quota | Stub (`configured: false`) |
| Integrated terminal (`/api/terminal/*` + WebSocket): your own shells on a PTY, command mode, resize, restart, reattach after reload | Real (sessions are sidecar-owned, not omp; idle sessions reaped after 30 min) |
| Add device / pairing (`/api/client-auth/*`): QR link, redeem, device list, revoke | Real, but tokens are **not enforced** elsewhere; the listen address is the access control. No relay (direct URLs only) |
| Dictation / TTS, dev servers, tunnels, walkthrough, scheduled tasks | Stub / disabled |
| Update check / upgrade status | Stub (`no update`) |
| LSP list | Stub (empty) |
| Auth (passkey, UI password) | Stub (no auth; bind to a trusted interface) |

Anything unlisted that falls through returns `404 not implemented`.

## Develop

```bash
bun run check    # type-check
bun test         # OpenChamber UI in headless Chromium -> sidecar -> stub omp, fully offline
```

`bun test` needs `openchamber` on `PATH` and Chromium (`CHROMIUM_PATH` overrides `/usr/bin/chromium`). Each run builds a throwaway `$HOME`, `PI_CODING_AGENT_DIR`, `TMPDIR` and OpenChamber data dir with an explicit child environment, so it never reads `~/.omp` or any API key. `omp` is `test/stub-omp/omp`, a scripted stand-in that speaks omp's RPC protocol and persists sessions the way omp does (bucket naming, `id`/`parentId` tree, session leases, `navigate_tree`/`fork`); `test/e2e/stack.ts` documents its script format. `E2E_KEEP=1` keeps the run directory. See [`docs/testing.md`](./docs/testing.md).

Layout: `src/server.ts` (routing) · `src/adapters/openchamber/` (OpenChamber/OpenCode compat) · `src/providers/omp/` (RPC, session store) · `src/shared/`.

Docs: [`architecture`](./docs/architecture.md) · [`api-reference`](./docs/api-reference.md) · [`providers`](./docs/providers.md) · [`omp-protocol`](./docs/omp-protocol.md) · [`openchamber-contract`](./docs/openchamber-contract.md)
