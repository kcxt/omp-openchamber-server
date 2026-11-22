# Sidecar core rewrite

Status: proposed. Owner of this document: the integration lead. Agents implementing a slice read only their slice plus §1–§4.

## 1. Why

Every bug fixed in this round came from the same design fault: **the sidecar keeps its own copy of state that omp owns, and the copies drift.**

| Symptom | The copy that drifted |
|---|---|
| Agent "has no history" after compaction, steer, restart | Sidecar lines appended to omp's JSONL broke omp's leaf pointer |
| Session flaps busy ↔ idle | Busy guessed from a transcript tail, verified seconds later |
| Stop rarely works | `state.busy`, `unsubscribe`, pending prompt promise tracked apart from omp |
| Effort ignored | `currentModel.variant` cached locally and gone stale |
| Goal mode prompts on every idle | A host-side audit loop beside omp's own goal |
| Compaction did nothing | A fresh child compacted its own empty session |

Measured today (`local://state.md`, `local://routes.md`):

- `/session/status` merges four sources: `SessionState.busy`, `followedStatuses`, `subagentStatusMap`, and a reconcile pass. `busy` alone is written at nine sites in `prompt.ts`; `emitSessionStatus` is called from twelve.
- ~50 mutable state items, ~30 module-level maps/sets/timers. Several are caches keyed on file stamps or TTLs over data omp already serves (`messageCache`, `headerCache`, `aliasIndex`, `recordedUserMessagesBySession`).
- Session data lives in four places: omp's JSONL (which the sidecar also *rewrites* for revert, fork, move), `<session>.jsonl.oc`, the SQLite title/message-id DB, and objective files under both `~/.config/openchamber/goals` and `~/.omp/goals`.
- `server.ts` is 3.4k lines, ~300 routes, with duplicate aliases and shadowed dead routes. `prompt.ts` (1.9k) mixes locking, idle timers, abort, compaction, goals, model state, event translation and titles.
- A multi-backend abstraction (`AgentBackend`, registry, namespaced provider ids, fake backend) has one real implementation; the e2e suite uses the stub omp, not the fake backend.

## 2. Rules (apply to every slice)

1. **omp is the source of truth for anything live**: busy/settled, model, effort, queue, goal, todos, context usage, transcript content and tree. The sidecar asks omp (`get_state`, events, `get_entries`) instead of remembering.
2. **The sidecar never writes omp's files.** No appends, no rewrites, no truncation. Tree changes go through omp RPC (`navigate_tree`, `fork`, `branch`, `compact`).
3. **Sidecar state is one of exactly three kinds:**
   - *Resource handles*: child processes, SSE clients, timers that release resources.
   - *Output dedupe*: what was last published to OpenChamber, used only to avoid re-sending. Never an input to a decision.
   - *Durable sidecar-owned data* in the one store (§4.4): things omp cannot hold (OpenChamber metadata, client message ids, user picks before a child exists).
   Anything else is a bug. New maps/flags need a line in §4 saying which kind they are.
4. **Status is a function, not a variable.** It is computed from the runtime state machine (driven sessions) or from lease + transcript (followed sessions) at the moment it is asked, and events are emitted when that function's output changes.
5. **Fail closed toward OpenChamber.** Unknown is not idle (OpenChamber treats an empty `/session/active` as "all idle" and starts queue/goal sends). Unknown is not busy either for a session with no live owner. Each status path states its unknown case explicitly.
6. One module per concern, one writer per piece of data. No module imports `server.ts`.

## 3. Target architecture

```
                 OpenChamber (UI + its server)
                          │ HTTP / SSE
 ┌────────────────────────▼─────────────────────────────────────────┐
 │ http/        router table → routes/<resource>.ts (thin handlers)  │
 ├───────────────────────────────────────────────────────────────────┤
 │ sessions/    SessionService: list/get/create/update/delete/fork   │
 │              Registry ─ SessionRuntime (one per driven session)   │
 │                         └ TurnTranslator (omp frames → OC events)  │
 │              Follower (read-only sessions owned by another omp)   │
 │              statusOf(session) ← runtime.state | lease+tail        │
 ├───────────────────────────────────────────────────────────────────┤
 │ omp/         RpcChild (NDJSON transport)   Utility (one shared     │
 │              child per cwd: models, commands, lease probes)        │
 │              TranscriptReader (pure: JSONL → records, active branch)│
 ├───────────────────────────────────────────────────────────────────┤
 │ store/       SessionDocs: one JSON doc per session (OpenChamber    │
 │              metadata, archived/viewed, staged revert)             │
 ├───────────────────────────────────────────────────────────────────┤
 │ events/      SSE/WS bus + OpenCode v2 wire encoding (from sse.ts)  │
 │ panels/      git, fs, terminal, project-context, settings (moved,  │
 │              not rewritten)                                        │
 └───────────────────────────────────────────────────────────────────┘
        │ stdio NDJSON                      │ read-only
   omp --mode rpc children            ~/.omp/agent/sessions/*.jsonl
```

### 3.1 The busy model, taken from omp

omp already defines exactly what OpenChamber calls "busy": an **activity stretch**. `RpcSessionSettleWatcher` (`modes/rpc/rpc-session-settle.ts`) opens a stretch on `agent_start` (or a pending host-scheduled turn such as a goal continuation) and closes it with one `session_settled` frame after the final run yields *and* background work that could wake the session (queued steer/follow-up, async bash/task, goal continuation) has drained. `prompt_result.sessionSettled` says whether that frame will follow.

So for a driven session:

- `active` from the first `agent_start` (or accepted `prompt` with `agentInvoked: true`) until `session_settled`, or `prompt_result{sessionSettled:true}`, or `prompt_result{agentInvoked:false}`.
- Steering, follow-ups, goal continuations, async-job wakes all live inside one stretch: no sidecar loop follows them.
- OpenChamber gets exactly one busy → idle per stretch, which is what its goal/queue/dispatch/guest consumers assume (`local://oc-contract.md` §3).

This deletes `SessionState.busy`, `followGoalTurns`, `pendingGoal`/`kickOffGoal`, `waitUntilStopped`, `isStreaming`, the 400 ms settle poll, and the busy-lock spin (`acquireSessionLock` polls every 5 ms).

### 3.2 SessionRuntime (one per driven session)

```ts
type RuntimeState = "starting" | "idle" | "active" | "aborting" | "closed";

class SessionRuntime {
  readonly sessionId: string;            // OpenCode id
  readonly cwd: string;
  get state(): RuntimeState;              // the only live-status input for driven sessions
  get transcriptPath(): string;           // from get_state.sessionFile after every stretch
  prompt(input: PromptInput): Promise<{ messageID: string }>;   // delivery: start | steer | followUp
  abort(): Promise<void>;                 // §3.4
  compact(instructions?: string): Promise<void>;
  setModel(pick: ModelPick): Promise<void>;                    // always pushes model AND effort
  goal(op: GoalOp, input?: GoalInput): Promise<void>;
  navigateTo(entryId: string): Promise<void>;                  // revert / redo
  fork(entryId?: string): Promise<string>;                     // returns new transcript path
  close(reason: "idle" | "deleted" | "shutdown" | "crash"): void;
  onStateChange(fn: (s: RuntimeState) => void): () => void;
}
```

- Owns one `RpcChild`. Commands run through a per-runtime serial queue (promise chain), not a global lock set.
- State transitions come only from omp frames and child exit. `aborting` is entered by `abort()` and left by `session_settled` or the abort deadline.
- Model/effort: no cached copy and no stored pick. `setModel` sends `set_model` (when `get_state.model` differs) and `set_thinking_level` whenever the pick has an effort; omp journals both. `POST /session/:id/model` applies immediately, starting a runtime if none is live.
- Idle release: the child closes once it is `idle`, `get_state.isSettled === true`, **and omp owes no idle maintenance** (`get_state.idleMaintenance` absent, P4), then waits `OC_CHILD_IDLE_MS` more. omp's idle recap (`recap.idleSeconds`, default 240 s) and idle compaction (`compaction.idleTimeoutSeconds`, default 300 s) therefore always run before release; the sidecar never mirrors those settings. Unreadable state keeps the child (fail closed). This is a resource timer (kind: handle). Note: today's 120 s release is shorter than the 240 s default recap delay, so a recap only appears if the user idles past it with a lowered `recap.idleSeconds` or the child was kept alive by something else.
- Child crash → `closed`; the active stretch is ended with an error turn and status goes idle. The next prompt creates a new runtime.
- The child opens its session with `switch_session { claimLease: true }` (P3), so omp never moves it to a sibling transcript; a refusal is the "owned elsewhere" error.

`Registry` is `Map<sessionKey, SessionRuntime>` plus creation (single-flight per key). It is the only map of live sessions.

### 3.3 TurnTranslator

Merges today's `providers/omp/events.ts` normalizer and `prompt.ts#createEventHandler` into one translator from omp frames to OpenCode events, owned by the runtime and reset per stretch. Its state (current assistant message id, part ordinals, open tool parts) is *output dedupe/assembly* for the stretch only.

- User messages appear in the stream as omp `message_start` (role user); that is where `session.inbox.delivered` is emitted, mapped to the client message id (§3.6).
- Assistant step boundaries, steer interruptions (`stopReason: aborted` followed by a new assistant message), tool parts, reasoning, usage: as today, ported with their tests.
- `session.execution.started` / `succeeded` / `interrupted` / `failed` are emitted from runtime state transitions, not from translator guesses.

### 3.4 Abort (Esc)

1. `state → aborting`; publish nothing new (still busy to OpenChamber).
2. Send omp `abort_and_restore_queue` (D3); the withdrawn queue text is returned to OpenChamber as un-sent queue items. R9: this aborts synchronous subagents with the parent turn but leaves async (background) subagents running, which keeps the stretch open. Esc means stop everything, so the runtime also sends `cancel_subagent` for every async subagent `get_subagents` reports as `pending`/`running`.
3. Wait until settled: `session_settled`, `prompt_result` with `sessionSettled`, or `get_state.isSettled === true` polled after the abort response (R1: a stretch stranded by queued input never emits `session_settled`, even after `abort_and_restore_queue`; the `abort` response itself arrives after `agent_end`). Bounded by `ABORT_DEADLINE_MS` (5 s).
4. On deadline: kill the child process group, `state → closed`, publish idle with `aborted: true`. The next prompt starts a fresh child on the same transcript.

There is no separate `killedOnAbort` flag and no dangling prompt promise: the prompt promise resolves on acceptance, not on turn end.

### 3.5 Status

```ts
function statusOf(sessionId, cwd): "busy" | "idle" | "unknown"
```

- Driven (`Registry` has a live runtime): `starting|active|aborting → busy`, `idle → idle`.
- Not driven: **lease first, tail second.** `lease = Utility.leaseHeld(id)` (one persistent child answers `get_session_lease` in milliseconds; no spawn per probe). `lease === false → idle`, regardless of the tail. `lease === true` → busy iff the transcript tail is mid-turn. Probe failure → `unknown`.
- `/session/status` and `/session/active` are built from `statusOf` over driven + followed sessions. `unknown` makes `/session/active` return an error, never an empty map (rule 5).
- Subagents: from `get_subagents` on the parent's runtime when asked, not a pushed map.

This removes the cold-read guess entirely: a dead tail is never busy because no process holds its lease. No dead-turn memory, no expiry interaction.

### 3.6 Follower (sessions another omp owns)

Read-only. For a session OpenChamber has open and the sidecar does not drive: poll the transcript stamp; on change, read via `TranscriptReader`, emit message deltas (output dedupe: last emitted signature per message), and re-evaluate `statusOf`. A status *change* emits `session.status` (+ `session.idle`). Stops when OpenChamber stops reading for 30 min and the lease is free.

Known limit, unchanged: omp streams tokens only to its own process, so followed sessions update per completed message.

### 3.7 Message ids

OpenChamber mints a client id per user message (optimistic UI, revert, fork, queue) and expects transcripts to use it. omp mints its own entry ids.

With patch P1, `prompt`/`steer`/`follow_up` carry `hostMessageId`, omp stores it on the user message entry, and `TranscriptReader` uses it as the message id when present. No ledger, no matching. Without P1 the fallback is: record client ids per stretch in order, and after `session_settled` pair them with the new user entries from `get_entries{since}` (R2), persisted in `SessionDoc`.

### 3.8 Goals

The OpenChamber goal record (`metadata.openchamber.goal`) stays OpenChamber's, stored in the sidecar store. The sidecar translates its writes into omp `goal` ops (create/resume/pause/drop) and mirrors `goal_updated` back (complete, budgetLimited, tokensUsed). Because omp keeps the stretch open while a continuation is pending (`goalTurnScheduled` feeds `isSettled`), the session stays busy for the whole goal without any sidecar loop. If a stretch settles with the goal still `active`, the record becomes `blocked`. The OpenChamber briefing reminder is stripped from prompts (it contradicts tool completion). Objective text is read from OpenChamber's objective file; the sidecar no longer writes `~/.omp/goals`.

### 3.9 Revert, redo, fork, move

- Revert to message M: `navigate_tree` to M's parent entry, then `append_custom_entry { customType: "host-revert" }` (P2). R3: `navigate_tree` alone moves the leaf in memory only; a child that dies before its next append loses the revert, and other processes still see the old leaf. The appended entry is parented on the new leaf, which makes the branch durable in omp's own tree. omp keeps the abandoned branch in the file and hides it; `TranscriptReader` shows only the active branch. Redo: the same two steps back to the abandoned leaf (kept in `SessionDoc.revert`). No file truncation.
- Fork: omp `fork` RPC. The new transcript is omp's; the store copies OpenChamber metadata to the new session id.
- Move to another directory: omp's builtin `/move <dir>` sent as a `prompt` on the session's runtime (R5: no model call, keeps the session id, rewrites the header and moves the file). A refusal arrives only as `command_output` with `success: true`, so the runtime parses it into an error. No sidecar header rewrite.

### 3.10 What the sidecar persists: one metadata document per session

OpenChamber's server treats the backend as the authority for session `metadata` (`openchamber-sessions/session-metadata-store.js`: read, RFC 7386 merge, write the whole object back). Goal records, assist recaps, pinned notes, obligatory-context state and turn timings all live there. omp has no equivalent, and it should not get one (§3.13 explains why not), so this is the one durable thing the sidecar owns.

Storage: `$OPENCHAMBER_DATA_DIR/omp-sessions/<omp session uuid>.json`, written by atomic temp-file + rename, one writer (the store module), serialised per session. No SQLite.

```ts
interface SessionDoc {
  metadata: Record<string, unknown>;   // OpenChamber's blob, replaced whole on PATCH
  archivedAt?: number;                 // OpenCode session fields omp has no notion of
  viewedAt?: number;
  revert?: { messageID: string; redoLeafId: string };  // staged revert (§3.9)
  legacyMessageIds?: Record<string, string>;            // omp entry id → client id, pre-migration only
}
```

Everything else is either omp's or derived:

| Data | Source of truth | Why the sidecar needs no copy |
|---|---|---|
| Title | omp: title slot + `set_session_name`; omp's own title generation (stop passing `--no-title`/`PI_NO_TITLE`) | Rename without a live child starts a runtime, as a prompt would |
| Model + effort | omp transcript (`model_change`, `thinking_level_change`) | A pick is applied immediately (`POST /session/:id/model` starts a runtime if none); omp journals it |
| Agent | none: omp has one agent | `agent_change` records are dropped |
| Client message ids | omp transcript, via patch P1 | `hostMessageId` stored on the user entry |
| Command notices | omp transcript, via patch P2 | journaled as a `custom` entry |
| Transcript moves (aliases) | not needed, via patch P3 | the child claims the lease on open, so omp never moves the session |
| Goal objective text | OpenChamber's objective file | read only |
| Todos, queue, goal state, context usage | omp `get_state` / `get_context_breakdown` | asked when needed |

Without P1–P3 the fallback is extra fields in `SessionDoc` (message-id map, notices, alias). Same store, same rules, still no SQLite.

Migration: a one-time, idempotent importer on startup builds `SessionDoc`s from `.jsonl.oc` records (`metadata`, `archive`, `viewed`, `revert_change`) and legacy id-less lines still inside transcripts, then renames the old files with a `.migrated` suffix. It runs before any child is spawned. Message ids from the title DB move into a read-only `legacyMessageIds` map in the doc (so revert-to on pre-migration messages keeps working); the title DB (`title-db.ts`) and `~/.omp/goals/*.txt` copies are then retired.

### 3.11 omp layer

- `RpcChild`: today's `OmpRpcConnection` minus session knowledge: spawn (detached process group), NDJSON framing, request/response with per-request timeout, event fan-out, death detection. Kept, trimmed.
- `OmpCli`: stateless one-shot subprocesses for everything that is not a driven session, all read-only (no lease, no writes): `omp session lease --json -- <ids…>` (0.17 s, batched), `omp models --json` (1.8 s; cached, invalidated when omp's `models.yml`/`config.yml` change), `omp session inspect --json <path>` (P6, ~2 s). Replaces Phase 1's long-lived `Utility` child (deleted in Phase 3), whose `switch_session` onto undriven sessions could write to, and so fork, a session a terminal omp owns. `/session/:id/shell` runs through the session's runtime when it has one, otherwise a plain `bash` spawn.
- Inspect prefetch: when OpenChamber opens an undriven session (first transcript read), the sidecar starts `inspect` in the background and memoises the result by transcript `(path, size, mtimeMs)`, so the context panel usually opens without the delay. It deliberately does *not* start a runtime opportunistically: a runtime claims the session's lease, which would block (and with omp's move rule, fork) a terminal omp resuming the same session.
- `TranscriptReader`: pure function JSONL text → `{ header, records, leafId, model, usage }`, memoised by `(path, size, mtimeNs)`. The single transcript parser: `store.ts#parseSessionHeader` and `messages.ts#loadMessagesFromFile` merge into it. No `get_messages` fallback.

### 3.12 HTTP layer

Per `local://routes.md` §14: `server.ts` becomes `Bun.serve` + an ordered route table + startup/shutdown (~150 lines). Routes move to `routes/{sessions,turns,transcript,revert,interactions,events,providers,config,goals,platform,fs,git,terminal}.ts`. Duplicate aliases collapse to one handler each; shadowed dead routes are deleted. Handlers parse, call a service, and serialise; they hold no state.

Panels (git, fs, terminal, project context, omp settings, browser control) move into `panels/` unchanged except for imports.

### 3.13 omp patches

The sidecar runs a patched omp (D2). Patches stay small, each one commit with its own test, written so it could go upstream.

**Kept from the current dev checkout** (all uncommitted on `main` today):

| Patch | Files | Verdict |
|---|---|---|
| Olla sticky sessions: `session-header "x-olla-session-id"` for llama.cpp | `catalog/src/compat/axes.ts`, `types.ts`, `rules/providers/llama.cpp.kdl`, regenerated `rules.json` | Keep. 3 lines + regen; upstreamable as a generic axis value. |
| RPC `get_context_breakdown` | `rpc-mode.ts`, `rpc-types.ts`, `rpc-client.ts`, `wire/{commands,state}.ts`, regenerated wire schema + Go/Python/Rust SDK wire, `context-usage-runtime.ts`, `test/context-breakdown-view.test.ts`, `docs/rpc.md`, CHANGELOG line | Keep: it feeds the context map (and later openchamber-context). One fix: `ContextBreakdownView` is defined in `rpc-types.ts` and imported by `session/context-usage-runtime.ts`, a session module depending on the RPC layer. Define it in `context-usage-runtime.ts` and re-export from `rpc-types.ts`. Verified working: `get_context_breakdown` answers on the dev launcher. |
| RPC sessions opt into idle maintenance (`session.enableIdleMaintenance()`) | `rpc-mode.ts` | Keep: the idle recap is shown in OpenChamber (`providers/omp/recap.ts` publishes it to `metadata.openchamber.assist`). Child release must not kill a child that still owes a recap or idle compaction (§3.2, P4). |
| Qwen 3.8 kept on hashline edits | `utils/edit-mode.ts`, `test/edit-mode.test.ts` | Personal model preference, 2 lines. Keep if you still prefer it; not upstreamable as-is. |

**Dropped:** the daemon (`src/daemon/`, `commands/daemon.ts`, `cli/daemon-cli.ts`, `test/daemon/`, `docs/daemon.md`, `MULTIPLEX.md`, and its lines in `cli-commands.ts`, `command-help.ts`, `docs/cli-reference.md`, CHANGELOG). `tools/browser/relay/extension-assets/background.js.txt` is build-path noise: revert. `olla.yaml` is deployment config: move out of the omp repo.

**New, to remove sidecar state:**

| # | Patch | Removes |
|---|---|---|
| P1 | `prompt` / `steer` / `follow_up` / `abort_and_prompt` accept `hostMessageId?: string`; omp stores it on the user message entry and echoes it in that message's `message_start`/`message_end` frames. | The message-id ledger (title DB tables, `recordedUserMessagesBySession`, `pendingInbox`, §3.7 fallback). |
| P2 | `append_custom_entry { customType, data }`: journals a `custom` entry through the session manager (proper `id`/`parentId`; `custom` entries are not sent to the model). | `oc_notice` persistence: command notify replies become transcript entries. |
| P3 | `switch_session { claimLease: true }`: take the ownership lease on open; fail with `session_busy` if another process holds it. | The probe-then-prompt race, transcript moves to siblings, `oc_alias`/`adoptTranscript`, and the "refuse if owned elsewhere" pre-check (the switch itself refuses). |
| P4 | `get_state.idleMaintenance: { recapDueAt?: number; compactionDueAt?: number }` (absent when nothing is owed), from `IdleMaintenance#pending` and its timers; plus a `recap` event frame `{ recap, createdAt }` from the existing `onRecap` hook. | Guessing omp's idle settings for child release (§3.2); `recap.ts` polling `history.db` for the recap. |
| P5 | `resume { subagentId?, hostMessageId? }` → `AgentSession.resume()` on the session or subagent, journaling a `host-resume` custom entry when `hostMessageId` is given (§3.14). | `.` reaching the model as a literal message; synthetic restart text. |
| P6 | `omp session inspect --json <sessionPath>`: normal startup, read-only session manager (no lease, every write path disabled), prints model, thinking level, context breakdown, commands, todos, goal, title, lease state. | The shared Utility child and its `switch_session` onto sessions it does not own (§3.11). |

**Not patched, deliberately:** OpenChamber metadata stays in the sidecar (§3.10). Putting it in omp's transcript would need the lease holder to write it (impossible while a terminal omp owns the session, and a child spawn per PATCH otherwise; OpenChamber writes turn timings every few seconds while a session is active), and transcript entries are branch-scoped, so a revert would hide session-level state.

**Known gap, no patch planned:** a session another omp holds and that is idle at its prompt, whose tail ends mid-turn from an earlier crashed process, reads busy (lease held + tail mid-turn) until that omp writes. A cross-process "is streaming" signal would close it; not worth a patch now.

### 3.14 Resume ("." in the composer, restart continuation)

In the TUI, `.` (or `c`) on its own calls `AgentSession.resume()` (`modes/controllers/input-controller.ts`): no user message is journaled; an idle session runs omp's recovery directive (`#recovery.prepareResume()`), a streaming one is interrupted and continued. It works on a focused subagent too. Over RPC there is no equivalent today: a `.` prompt is journaled as a literal user message and sent to the model.

Patch P5 adds `resume { subagentId?: string; hostMessageId?: string }`, calling `resume()` on the session or the named subagent's session. When `hostMessageId` is given, omp first journals `custom { customType: "host-resume", data: { hostMessageId, text } }` in that session's transcript (a `custom` entry, so the model never sees it).

Sidecar wiring:

- A prompt whose whole text is `.` becomes `runtime.resume({ hostMessageId: clientId })`; on a subagent session it becomes `resume { subagentId }` on the parent runtime. `c` stays a normal message (too plausible as a real answer).
- `TranscriptReader` maps a `host-resume` entry to a user message with the client's id and text `.`. OpenChamber's optimistic bubble is therefore confirmed by the transcript, never deleted: it survives reload, and the model's continuation follows it, so the tail is an assistant message as OpenChamber's queue expects.
- If omp has nothing to resume, the runtime journals a notice (P2) after the marker, so the tail is still not a dangling user message.
- OpenChamber's own restart continuation (`POST /session/:id/synthetic { resume: true, metadata.notice: "opencode-restart" }`, `opencode/session-runtime.js`) maps to the same `resume`, so a turn interrupted by a sidecar restart is continued with omp's recovery directive instead of a synthetic text prompt.

### 3.15 Subagents

**How omp runs them.** A subagent is not a separate omp process. The `task` tool creates an in-process `AgentSession` inside the parent's omp child (`task/executor.ts` → `createAgentSession`), writing an artifact transcript next to the parent (`<parent>/<Name>.jsonl`). Synchronous tasks run inside the parent's turn; async (background) tasks count as pending async work, so the parent's activity stretch stays open until they finish (§3.1). The host sees them through the parent's RPC stream:

- `set_subagent_subscription { level: "events" }` → `subagent_lifecycle` (started / completed / failed / aborted, with `sessionFile` and `parentToolCallId`), `subagent_progress`, and `subagent_event` (the child's full `AgentSessionEvent` stream).
- `get_subagents` (snapshots), `get_subagent_messages { subagentId | sessionFile, fromByte }`, `cancel_subagent`, `steer_subagent`.

**How the sidecar wires them.** The parent's `SessionRuntime` owns its subagents. There is never a runtime or omp child for a subagent session.

- Identity: the child's OpenCode session id comes from the artifact file's header (`sessionFile` in the lifecycle payload). No name-matching heuristic (`resolveOmpSubagentOpenCodeId` goes).
- Live view: the runtime runs one `TurnTranslator` per running subagent over its `subagent_event` stream and emits under the child's session id, so a child session in OpenChamber streams like a root session. Today the sidecar drops `subagent_event` and only maps lifecycle and progress to a busy flag. R9: `subagent_event` is the child's full unfiltered stream (it bypasses `set_event_filter`, so `message_update` arrives in full form, not delta) and has no replay; on subscribe or reconnect, backfill with `get_subagent_messages`. The translator must therefore accept full-form updates and derive deltas itself.
- Status: `statusOf(child)` = busy iff the parent runtime's latest snapshot (`get_subagents`, refreshed on lifecycle frames) says `pending`/`running`. No `subagentStatusMap`, no reconcile pass. A child of an undriven parent is followed like any other transcript: idle unless the parent's lease is held and the child's tail is mid-turn.
- Transcript: `TranscriptReader` on the artifact file, as for any session.
- Prompting a child session routes to `steer_subagent` while it runs (pending tasks are not steerable yet; the prompt waits for `running`). Stopping it routes to `cancel_subagent`. `.` on a child routes to P5 `resume { subagentId }`, which also revives a finished subagent that is still registered; any other prompt to a finished child is refused with an explanation.

Today a prompt to a child session can reach `promptSessionAsync`, which would spawn a second omp child on the artifact file while the parent process may still be writing it. The rewrite makes that unrepresentable: `Registry` creates runtimes only for root sessions.

## 4. What is deleted

| Today | Replaced by |
|---|---|
| `SessionState.busy`, `getSessionStatusMap`, `followedStatuses` merge, `reconcileSessionStatuses`, `subagentStatusMap`, `resolveOmpSubagentOpenCodeId` name matching | `statusOf` (§3.5); subagents owned by the parent runtime (§3.15) |
| `recap.ts` reading `history.db` on a 30 s TTL for every session | P4 `recap` frame for driven sessions; `history.db` read only for sessions another omp owns |
| `acquireSessionLock` spin, `sessionBusyLocks` | per-runtime command queue |
| `currentModel` copy, `sameModel` skip | `setModel` always pushes, reads `get_state` |
| `followGoalTurns`, `pendingGoal`, `kickOffGoal`, `goalSyncedAt` throttle | omp stretch + `goal_updated` mirror (§3.8) |
| `deadTurns` (removed already), follow cold-read busy | lease-first status |
| `waitUntilStopped`, `killedOnAbort`, prompt-promise-as-turn | §3.4 |
| `oc-records.ts`, `.jsonl.oc`, legacy quarantine | `SessionDoc` + importer |
| `truncateOmpSessionAtMessage`, `forkOmpSession` file surgery | `navigate_tree`, `fork` RPC |
| `messageCache` TTL + `invalidateMessageCache` hooks, `headerCache`, `aliasIndex`, `adoptOmpTranscript` | memoised `TranscriptReader`; P3 (no moves) |
| `recordedUserMessagesBySession`, `pendingInbox`, `title-db.ts` (titles + message ids) | P1 `hostMessageId`; omp titles |
| sidecar title generation (`title.ts` callers, `--no-title`, `PI_NO_TITLE`) | omp's title generation |
| `oc_notice` records | P2 `append_custom_entry` |
| `withOmpRpc` one-shots | `Utility` |
| `~/.omp/goals/*.txt` writes | OpenChamber's objective file only |
| `AgentBackend` registry, namespaced provider ids, fake backend | omp-only modules (D1) |

## 5. Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Keep the multi-backend abstraction (`AgentBackend`, registry, fake backend, `ses_<backend>_` ids)? | Remove. Re-add when a second backend is real. |
| D2 | Which omp? | The dev checkout on a `local` branch: upstream + the patches in §3.13, one commit each, rebased on upstream. The sidecar runs it through `--binary`; contract tests run against it. |
| D3 | Esc with queued steer/follow-ups | `abort_and_restore_queue` (TUI Esc); withdrawn text goes back to OpenChamber as un-sent queue items. |
| D4 | Titles | From omp: its title generation and `set_session_name`. Sidecar title generation and the title DB are deleted. |
| D5 | Effort "default" | Send `set_thinking_level` with omp's default for the model, so the UI pick is what runs. |
| D6 | Sidecar persistence | One JSON document per session (§3.10); no SQLite. |

## 6. Research items (Phase 0, against the pinned real omp, no model calls)

All runnable with a throwaway `PI_CODING_AGENT_DIR` and no provider credentials (AGENTS.md): they exercise session/tree/lease commands only, or use the stub where a model turn is needed.

| # | Question | How |
|---|---|---|
| R1 | Exact frame order for a stretch: `agent_start`, `prompt_result`, `agent_end`, `session_settled`; with steer, follow-up, goal continuation, abort, compaction. | Read `rpc-mode.ts`/`rpc-session-settle.ts`; record a stub run; make the stub match. |
| R2 | `get_entries{since}` returns user entries in acceptance order; behaviour across compaction (`unknown_since`). | Real omp: `switch_session` onto a fixture transcript, then `get_entries` with and without `since` (no model call). Append order under steer/follow-up from source (`session-manager.ts`), then pinned in the stub. |
| R3 | `navigate_tree` reproduces OpenChamber revert/redo semantics (file content + `get_messages` after). | Real omp on a fixture transcript. |
| R4 | `fork` RPC output path, header, lineage; vs current fork-from-message behaviour. | Real omp on a fixture transcript. |
| R5 | Directory move without a live child: omp command (`move-directory-source.ts`) or one documented sidecar header rewrite. | Read source; real omp on a fixture. |
| R6 | `get_session_lease` from a sessionless utility child: latency, correctness vs a terminal omp holding the lease, and the open-but-unwritten gap. | Real omp: hold a lease in one process, probe from another. |
| R7 | Stub fidelity diff: every frame the sidecar consumes, stub vs real (`docs/testing.md` "Stub fidelity"). | Contract test file run against both binaries for model-free commands. |
| R8 | P1–P5 behave as specified, including P1 ids surviving compaction and fork, P3 refusing while a terminal omp holds the lease, P4 reporting idle work owed across recap and idle compaction, and P5 on an idle session, a streaming one, and a subagent. | Tests in the omp patch branch, plus the contract suite. |
| R9 | Subagent wiring (§3.15): `subagent_event` payloads carry a full child event stream the TurnTranslator can consume; whether `steer_subagent` works for a running async task; what `abort_and_restore_queue` does to running sync and async subagents. | Read `task/executor.ts`, `rpc-subagents.ts`, `agent-session.ts#abort`; stub frames recorded from source. |

Output: `docs/omp-protocol.md` rewritten as the verified contract, and a `test/contract/` suite that runs model-free commands against the pinned real omp and the stub.

## 7. Phases and slices

Each phase ends with the full e2e suite green (`bun test`, currently 60/60). Slices within a phase run in parallel; each slice owns its files. Shared contracts are the TS interfaces in §3; a slice that needs a change to one asks the integration lead.

**Phase 0: ground truth + omp patches** (one agent + lead)
- Land the omp patch branch (§3.13): commit the kept patches, write P1–P5, drop the daemon work.
- R1–R9 against that build; update stub (incl. subagent frames and `idleMaintenance`); write `docs/omp-protocol.md` and `test/contract/`.

**Phase 1: foundations** (parallel with Phase 0's omp patch work; no behaviour change, old paths keep working)
- 1A `src/omp/rpc-child.ts`, `src/omp/utility.ts` (lease, models, commands, context breakdown, shell). Switch `withOmpRpc` callers outside `server.ts`; the `server.ts` call sites move with 1D and are switched at integration.
- 1B data layer: `src/omp/transcript-reader.ts` and `src/store/session-docs.ts` + importer; switch `store.ts` header parsing, `messages.ts` transcript loading and every `.oc` read/write to them, behind the existing `store.ts` API so callers do not change yet.
- 1D `src/http/` router + route modules; move non-session routes and panels out of `server.ts` (pure moves, delete duplicates/dead routes).

**Phase 2: session core** (one agent; the critical path)
- `sessions/runtime.ts`, `sessions/registry.ts`, `sessions/turn-translator.ts`, `sessions/status.ts`. Ported translator tests stay green through the e2e suite.

**Phase 3: cut over** (parallel after Phase 2)
- 3A turn routes (prompt/prompt_async/message/command/shell/abort/interrupt/compact) onto runtimes; delete `prompt.ts` paths.
- 3B revert/redo/fork onto `navigate_tree`/`fork`; message-id mapping §3.7; delete file surgery.
- 3C follower rewrite on `statusOf`; delete `follow.ts` busy inference.
- 3D goals onto runtime + store; delete goal loop.
- 3F replace `Utility` with the one-shot `OmpCli` (§3.11): lease, models, inspect + prefetch; shell via runtime or plain bash; delete `src/omp/utility.ts` and `withOmpRpc`.
- 3E model/effort/title routes apply through a runtime (started on demand); delete `currentModel` and the `.oc` `model_change`/`agent_change` records.

**Phase 4: removal and docs**
- Delete `oc-records.ts`, `title-db.ts`, sidecar title generation, `AgentBackend` (D1), dead exports. `bun run check` clean (today ~16 errors).
- Rewrite `docs/architecture.md`, `docs/api-reference.md` status/turn sections, `docs/testing.md` coverage table.

## 8. Test plan

- The e2e suite is the behavioural contract and must stay green at every phase boundary. New tests only where it has no coverage and the rewrite changes behaviour: steer/follow-up inside one stretch (one busy → idle), abort with queued input (D3), abort deadline kill, revert/redo through `navigate_tree`, lease-first status for a followed session (exists: `follow.test.ts`), goal continuation without sidecar polling (exists: `goal.test.ts`).
- `test/contract/` (Phase 0) runs omp commands against the pinned real binary and the stub, so stub drift is caught.
- **No live credentials, ever.** Every test that starts a real omp (contract suite, omp patch tests, smoke runs) uses one harness that:
  - points `HOME`, `PI_CODING_AGENT_DIR`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME` and `TMPDIR` at a throwaway directory, so `~/.omp/agent/agent.db`, `models.yml`, `config.yml` and the real session store are unreachable;
  - starts the child with an allow-listed environment (`PATH`, the throwaway dirs, `PI_*` test flags), never `...Bun.env`, so `*_API_KEY`, `*_TOKEN` and OAuth variables cannot leak in;
  - writes a `models.yml` with exactly one provider, `fake`, an `openai-completions` endpoint at `http://127.0.0.1:<port>/v1` served by a scripted in-test HTTP server (`test/contract/fake-provider.ts`) with `apiKey: dummy`. omp's own `ai/src/providers/mock.ts` is in-process only and cannot serve an `omp --mode rpc` child, hence the local HTTP fake;
  - asserts on startup that `get_available_models` lists only `fake/*` and fails the run otherwise.
  Model-free commands (lease, tree, entries, fork) need no provider at all; model turns go to the fake server.
- No live provider calls (AGENTS.md).

## 9. Risks

- **Stub ≠ omp.** The e2e suite only proves what the stub does. Mitigation: R7 + contract suite before Phase 2.
- **omp internals.** The lease probe goes through omp's own RPC (`get_session_lease`), never its lock paths, so an omp upgrade cannot silently break it.
- **Migration of user data.** The importer is idempotent, runs before children spawn, and renames rather than deletes. Dry-run mode logs what it would move.
- **Concurrent edits.** Several agents have been editing this checkout. The rewrite runs on a branch/worktree; Phase 1 slices own disjoint files.

## 10. Later (after Phase 4)

- **Bash tool rendering.** omp's TUI renders bash calls with one-liners split into steps and syntax colouring. Bring that into OpenChamber's tool card: find omp's renderer (tui tool views for `bash`), decide whether to send pre-rendered segments in the tool part's `metadata` (sidecar-side, reusing omp's tokenizer) or ship a renderer in an OpenChamber extension panel.
- **Low-latency reasoning streaming.** The sidecar already serves events over WebSocket (`/api/global/event/ws`, capability `realtime.websocket.global-events.v1`) as well as SSE, and OpenChamber's websocket setting selects it. Before switching anything, measure: time from omp `thinking_delta` on the child's stdout to the delta reaching the browser, on SSE vs WS. Likely costs are elsewhere: the translator batching or re-emitting whole parts instead of deltas, `message.part.updated` full-text updates per delta, or OpenChamber's own reducer. The TurnTranslator (§3.3) must emit `message.part.delta` per omp delta with no batching; the e2e suite has no latency check today, so Phase 2 adds one (stub emits timed deltas, the test asserts arrival spacing in the UI stream).
