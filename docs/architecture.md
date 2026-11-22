# Server Architecture

`omp-openchamber-server` is a sidecar written in TypeScript for [Bun](https://bun.sh). It serves the OpenCode v2 HTTP/SSE API that [OpenChamber](https://github.com/OpenChamber/OpenChamber) speaks, and drives [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) through its stdio RPC. Neither project is modified in place: the sidecar needs the patched omp from the `local` branch (see "omp patches" below).

The design rule is in `PLAN.md` §2: **omp owns every piece of live state** (busy, model, effort, queue, goal, todos, context usage, transcript, tree) and the sidecar asks omp instead of keeping a copy. The sidecar never edits omp's transcripts: tree changes go through omp RPC. The only file operations on an omp transcript are the two lifecycle ones, creating the file for a new session (title slot + header, before any omp has it open) and unlinking it on `DELETE /session/:id`.

## Layout

```text
src/main.ts           process entrypoint
src/server.ts         Bun.serve, WebSocket upgrades, dispatch into the route table
src/http/             Request context and the ordered route dispatcher (router.ts), response helpers, access log
src/routes/           one module per resource; handlers parse, call a service, serialise (no state)
src/services/         startup/shutdown (runtime.ts), session lookup + "open elsewhere" refusal (session-route.ts),
                      process-lifetime runtimes (instances.ts), settings file, projects
src/sessions/         SessionRuntime, Registry, TurnTranslator, status, service, aside, prompt input, recap
src/omp/              everything that talks to or reads from omp (below)
src/store/            sessions.ts (session catalogue), session-docs.ts (the one durable store), importer.ts
src/panels/           git, terminal, project context, omp settings, browser control (moved, not rewritten)
src/adapters/openchamber/   OpenChamber/OpenCode compat that is not session core: follow, goal-check answer, message
                      queue, approvals, small model, omp config routes, v2 wire shapes, usage stats
src/adapters/openchamber/extensions/   omp extensions loaded into every driven child (question, web, image budget)
src/shared/           types.ts (OpenCode shapes), sse.ts (event bus + v2 encoding), logger, ids, blobs, tool normalisation
extensions/           OpenChamber guest extensions (omp-settings panel; oh-my-pi panel: context, goal, tasks)
test/                 e2e (UI -> sidecar -> stub omp), contract (stub and real omp), stub-omp
```

```
                 OpenChamber (UI + its server)
                          │ HTTP / SSE / WS
 ┌────────────────────────▼──────────────────────────────────────────┐
 │ http/ + routes/   ordered table of handlers, first answer wins     │
 ├────────────────────────────────────────────────────────────────────┤
 │ sessions/   service ─ Registry ─ SessionRuntime (one per driven    │
 │             session) ─ TurnTranslator; status.ts: statusOf         │
 │ adapters/openchamber/follow.ts   read-only sessions another omp owns│
 ├────────────────────────────────────────────────────────────────────┤
 │ omp/   RpcChild (NDJSON transport)   OmpCli (one-shot, read-only)   │
 │        TranscriptReader (JSONL → entries, memoised)                 │
 │        messages.ts (entries → OpenCode records)                     │
 ├────────────────────────────────────────────────────────────────────┤
 │ store/ SessionDocs (JSON per session)   sessions.ts (catalogue)     │
 │ shared/sse.ts  event bus + OpenCode v2 wire encoding                │
 └────────────────────────────────────────────────────────────────────┘
        │ stdio NDJSON                      │ read-only
  omp --mode rpc children            ~/.omp/agent/sessions/*.jsonl
```

## HTTP layer (`src/server.ts`, `src/http/`, `src/routes/`)

`server.ts` is `Bun.serve` plus WebSocket upgrades (events, terminal). Every request goes through `dispatch` in `http/router.ts` over the table in `routes/index.ts`: `platform, fs, git, config, omp-settings, events, interactions, sessions, goals, revert, turns, transcript, providers, terminal`. The first handler that returns a `Response` wins and `undefined` falls through, so order is behaviour: broad matchers stay behind the modules whose exact routes they would shadow. `?directory=` (or the `x-opencode-directory` header) scopes a request to a project. Startup (CLI parse, omp binary check, importer, banner, endpoint file, signal handling) and shutdown live in `services/runtime.ts`.

## Sessions (`src/sessions/`)

**`SessionRuntime`** (`runtime.ts`) is one driven session: an `omp --mode rpc` child that holds the session's lease, a state machine `starting | idle | active | aborting | closed` driven only by omp frames and child exit, a serial command queue, and the `TurnTranslator`s for the session's stream. The child opens its session with `switch_session { claimLease: true }` (P3), so omp never moves it to a sibling transcript; a refusal is the "owned elsewhere" error (HTTP 409/400, see `docs/api-reference.md`). Nothing about model, effort, goal or queue is cached: `setModel` always pushes `set_model` (when `get_state.model` differs) and `set_thinking_level`, and omp journals both.

**`Registry`** (`registry.ts`) is the only map of live runtimes (`sessionId + cwd` → runtime) with single-flight creation. It creates runtimes for root sessions only: a subagent session is driven through its parent's runtime (`steer_subagent`, `cancel_subagent`, `resume { subagentId }`), never by a second omp child writing the parent's artifact file. It also wires runtime events to OpenChamber: busy/idle publication, usage after a run, the goal mirror, and omp's idle recap into `metadata.openchamber.assist`.

**`TurnTranslator`** (`turn-translator.ts`) turns omp frames into OpenCode events (message, part, tool, reasoning, usage, `session.inbox.delivered`). Its state is output assembly for one stretch only. Every text/thinking delta becomes one `message.part.delta`, never batched; subagent streams arrive as full-form snapshots and the translator derives deltas.

**`service.ts`** holds the operations the routes call: prompt (delivery `start | steer | followUp`, `.` as omp's resume), abort, compact, model, goal, shell, revert/redo/fork/move/rename, teardown. **`aside.ts`** maps omp's `/btw` frames to messages (see `docs/api-reference.md`, "Side questions"). **`recap.ts`** publishes omp's idle recap. **`prompt-input.ts`** turns an OpenChamber prompt body into omp's message, images and client message id.

### The busy model

`status.ts` computes status when asked (`PLAN.md` §3.5, `docs/omp-protocol.md` §4):

| Session | Status |
|---|---|
| Driven (a live runtime) | `starting`, `active`, `aborting` → busy; `idle` → idle |
| Starting (runtime being spawned) | busy |
| Subagent of a driven parent | busy while the parent's `get_subagents` snapshot says `pending`/`running` |
| Not driven | **lease first, tail second**: no lease holder → idle; a holder → busy iff the transcript tail is mid-turn; probe failure → `unknown` |

Busy is the **parent's own work**: `active` from an accepted prompt or `agent_start` until the run's terminal `agent_end`, and through the gap before a run omp already decided to start (a goal continuation: `get_state.isSettled === false`, no pending async work, nothing queued). Background subagents and async jobs leave the parent idle; their child sessions are busy, and `/experimental/job` lists them. A queued steer/follow-up, goal continuation, or background result that wakes the parent arrives as a new `agent_start`, so OpenChamber can see several busy → idle pairs inside one omp stretch. `unknown` makes `/session/active` return `503` and is never reported as idle. There is no sidecar loop following goal turns, no settle poll and no busy lock.

`runtime.state` and `statusOf` are the only inputs to status. A transition emits `session.status` (+ `session.idle`) only when the busy/idle value changes (output dedupe).

### Abort

Esc sends `abort_and_restore_queue`: the parent run and its synchronous subagents stop, queued steer/follow-up text is withdrawn and returned in the `/interrupt` response (`withdrawn`), and its inbox bubbles are cancelled. The runtime then waits for the run to stop (`agent_end`, or `get_state.isStreaming === false`), bounded by `ABORT_DEADLINE_MS` (5 s); past the deadline the child's process group is killed, state becomes `closed` and idle is published with `aborted: true`. The next prompt starts a fresh child on the same transcript. Background subagents keep running by design.

### Child lifetime

A child is released after `OC_CHILD_IDLE_MS` once it is `idle`, `get_state.isSettled === true`, and omp owes no idle maintenance (`get_state.idleMaintenance` absent, P4), so omp's idle recap and idle compaction always run first. Unreadable state keeps the child. A crash ends the active stretch with an error turn and goes idle.

## omp layer (`src/omp/`)

- **`rpc-child.ts` (`RpcChild`)**: spawn in a detached process group, NDJSON framing, request/response with per-request timeout, event fan-out, death detection. Gated on the first `get_state` reply. Overlays `mcp.enableProjectConfig: false` and passes `PI_SKIP_VERSION_CHECK=1`. Caller-owned credentials (`credentials` / `credentialRef`) get a private temporary `PI_CODING_AGENT_DIR` with a generated `models.yml` (`credentials.ts`, `credential-runtime.ts`); otherwise the child inherits omp's normal auth.
- **`cli.ts` (`OmpCli`)**: stateless one-shot subprocesses for sessions that are not driven, all read-only (no lease, no writes): `omp session lease --json -- <ids…>` (batched ownership probe), `omp models --json` (cached until omp's config changes), `omp session inspect --json <path>` (P6: model, effort, context breakdown, commands, todos, goal; memoised by transcript stamp and prefetched on the first transcript read of an undriven session). It deliberately never starts a runtime opportunistically, which would claim the lease and block a terminal omp.
- **`transcript-reader.ts`**: the single JSONL parser. Reads only. Memoised by `(path, size, mtimeMs)`; the active branch is the path from omp's leaf to the root, abandoned branches stay in the file. Full parses sit in a byte-bounded LRU, the small per-file summary (header, title, leaf, model, usage) is kept for the life of the process because the session list needs one per file.
- **`messages.ts`**: entries → OpenCode `{info, parts}` records (message ids come from `hostMessageId`, P1; `host-resume` and `custom` entries become messages; legacy ids from `SessionDoc.legacyMessageIds`). `context.ts`, `todo.ts`, `btw-history.ts`, `title.ts`: transcript-derived context figures, todo/tool-name mapping, read-only `/btw` store, the title slot written when a session file is created.
- **`binary.ts`, `rpc.ts`, `models.ts`, `paths.ts`, `update-check.ts`**: binary resolution (`--binary`/`OMP_BIN`, else the staged `resources/omp`), child config overlay and model catalogue mapping, omp directory layout, release check (reports, never replaces the pinned binary).

## Persistence

| Data | Source of truth |
|---|---|
| Transcript, tree, title, model, effort, todos, goal state, queue, context usage, recap | omp (transcript, `get_state`, `get_entries`, `session inspect`) |
| Client message ids | omp transcript, via P1 `hostMessageId` |
| Command replies / notices | omp transcript, via P2 `append_custom_entry` |
| Staged revert | omp transcript (`host-revert` entry) + `SessionDoc.revert` for the redo leaf |
| OpenChamber metadata (goal record, assist, pins, timings), archived, viewed | `SessionDoc` |

`store/session-docs.ts` (`SessionDocs`) is the one durable store: `$OPENCHAMBER_DATA_DIR/omp-sessions/<omp uuid>.json` (default data dir `~/.config/openchamber`), written by temp file + rename, serialised per session, one writer, no SQLite. Fields: `metadata`, `archivedAt`, `viewedAt`, `revert`, and the pre-migration `legacyMessageIds`, `visibleParts` (the typed text of a prompt that carried synthetic context) and `legacyNotices`.

`store/importer.ts` is the one-time, idempotent migration from the old sidecar state (`<session>.jsonl.oc` records, id-less lines inside transcripts, the title DB's message ids). It runs at startup before any child is spawned, moves the old data into the doc, and renames old files with a `.migrated` suffix. `store/sessions.ts` builds the OpenCode session list/get/create/update/delete from transcript summaries overlaid with the doc. Session ids: an omp UUID maps to `ses_<32hex>` and back; OpenChamber's client-minted `ses_<nanoid>` ids are stored verbatim as `openCodeId` in the transcript header. Ids are omp-only: there is no backend prefix.

## Followed sessions

`adapters/openchamber/follow.ts` serves a session another omp (typically a terminal) owns, read-only: it polls the transcript stamp from the moment a client reads the session's messages, turns each growth into the events a live turn would have produced, and re-evaluates `statusOf` on change (and at a slow interval while not idle, since the lease can drop without the file changing). Tokens stream only to the owning process, so updates arrive per completed message. It stops after 30 minutes without reads once the lease is free. A session the sidecar drives is never emitted from here, and nothing is written or forked.

## Events (`src/shared/sse.ts`)

An in-process bus encodes OpenCode events for SSE and WebSocket clients, including the v2 envelope (`session.*`, `message.part.*`, `session.inbox.*`, `session.execution.*`). What was last published is output dedupe and never an input to a decision.

## Goals

omp's goal mode is driven by the sidecar's `/goal` command (`service.ts`: create/pause/resume/drop on the session's runtime) and read back at `GET /api/omp/goal/:id` (`routes/goals.ts`: the live child's `get_state`, else `omp/goal.ts` reads the transcript's last `mode_change`/`goal-completed`). omp keeps the stretch open while a continuation is pending, so the session stays busy for the whole goal with no sidecar loop. OpenChamber's own Session goal is not served (switched off in its settings); its progress-check prompt is answered without a model (`adapters/openchamber/goal.ts`).

## omp patches

The sidecar runs the `local` branch of omp (upstream plus the patches below, one commit each), passed with `--binary` or `OMP_BIN`. The wire-level contract for each is in `docs/omp-protocol.md` §11; tests are in `test/contract/`.

| Patch | What it adds | Doc |
|---|---|---|
| P1 | `hostMessageId` on `prompt`/`steer`/`follow_up`/`abort_and_prompt`, stored on the user entry and echoed in its frames | §11.1 |
| P2 | `append_custom_entry { customType, data }` | §11.2 |
| P3 | `switch_session { claimLease: true }`, refusal as `session_busy` | §11.3 |
| P4 | `get_state.idleMaintenance` and the `recap` event frame | §11.4 |
| P5 | `resume { subagentId?, hostMessageId? }` | §11.5 |
| P6 | `omp session inspect --json <path>` (read-only) | §11.6 |
| — | `get_context_breakdown`, RPC sessions opting into idle maintenance, local config tweaks | `docs/omp-protocol.md` |

## Core invariants

1. **omp is the source of truth** for anything live; sidecar state is a resource handle, output dedupe, or the `SessionDoc`.
2. **Status is a function**: runtime state for driven sessions, lease + transcript tail otherwise. Unknown is neither idle nor busy.
3. **Stable URLs**: `ses_<32hex>` ids map to the same omp UUID across restarts; client-minted ids are stored in the header.
4. **No polling for driven sessions**: state comes from omp frames. Followed sessions poll a file stamp.
5. **One module per concern, one writer per piece of data**; no module imports `server.ts`.
