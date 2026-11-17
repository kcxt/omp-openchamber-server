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
| omp settings (`omp config`): editor laid out like omp's own `/settings` (tabs, groups, readable names, dropdowns with option descriptions, model pickers, per-role model assignments, conditional rows); anything not in omp's layout is under Advanced. JSON at `/api/omp/settings`, standalone page at `/api/omp/settings/ui` (OpenChamber blocks framing it, so it cannot be embedded), and a rail panel shipped as an OpenChamber extension in [`extensions/omp-settings`](./extensions/omp-settings) | Real. `install.sh` and `bin/openchamber-serve` register the panel (`bin/register-extensions` adds it to OpenChamber's `extensions.json`); allow its local service once in Settings → Extensions. The service forwards to the sidecar on `127.0.0.1:4096` (fixed: services do not inherit the environment). The layout is a snapshot of omp 18.19.0 (`bun scripts/gen-omp-settings-schema.ts` regenerates it after an omp bump; the panel warns on a version mismatch). Bridge vendored from [Kabmo](https://github.com/kabmo-labs/kabmo) (MIT, `src/vendor/kabmo`) |
| Streaming (SSE + WebSocket events), tool parts, subagents, images | Real |
| Permissions, questions, forms | Real |
| Message queue / inbox (list, reorder, hold, take, delete) | Real; switching a queued item's delivery mode returns 409 |
| Git panel (status, diff, commit, branch, worktree, stash, log, identity, PR text) | Real (local `git`) |
| Source-control binding | Sidecar: always reports repo with no hosted-forge binding |
| File browser / read / write / rename / delete / clone / stat / directory availability | Real |
| Project context, session knowledge | Real |
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
bun test         # unit + contract suites (unset OC_SIDECAR_HOST first)
bun run test:live
```

Layout: `src/server.ts` (routing) · `src/adapters/openchamber/` (OpenChamber/OpenCode compat) · `src/adapters/jarvis/` · `src/providers/omp/` (RPC, session store) · `src/shared/`.

Docs: [`architecture`](./docs/architecture.md) · [`api-reference`](./docs/api-reference.md) · [`providers`](./docs/providers.md) · [`omp-protocol`](./docs/omp-protocol.md) · [`openchamber-contract`](./docs/openchamber-contract.md)
