# oh-my-pi (omp) RPC contract

What the sidecar may rely on when it drives `omp --mode rpc`. Every statement here is pinned by `test/contract/` (run against the pinned real omp build and the stub) unless marked `[INFERENCE]` or `[source only]`. Evidence and omp source citations: `docs/research/R1.md` … `R7.md`, `R9-subagents.md`, `R10-parent-idle.md`. Command and frame names come from omp's `modes/rpc/rpc-mode.ts`, `rpc-types.ts` and `docs/rpc.md`.

Pinned omp: the patched `main` branch of `/hdd/brute/projects/oh-my-pi` (upstream + kept patches + P1–P8 of PLAN §3.13; protocol version 1 announced, versions 1 and 2 supported). The patches are §11; everything else in this file is stock omp.

## 1. Process and transport

```
omp --mode rpc --cwd <dir> --no-title --no-pty [--config <overlay>] [--extension <path>…]
```

- NDJSON on stdin/stdout. A command is `{"id":"<correlation id>","type":"<command>",…}`; the response is `{"id","type":"response","command","success":true,"data"?}` or `{…,"success":false,"error","code"?}`. Every other line is an unsolicited event frame.
- First frame is `ready` (`protocolVersion`, `supportedProtocolVersions`, frame size limits). It can lag behind slow project startup, so the sidecar probes `get_state` and treats the first response as ready.
- Cold start of the real child is ~1.7 s (until `get_available_models` answers).
- The sidecar separately checks the latest stable omp release after startup and every four hours. It only reports availability; updating is a deliberate pin change (`ompVersion` in `package.json`, staged on the next startup) so active sessions are never replaced underneath the server.
- The child is launched detached in its own process group and terminated as a group. `PI_SKIP_VERSION_CHECK=1` disables the startup update check; `mcp.enableProjectConfig:false` keeps project MCP servers from stalling startup.
- An unknown command answers `success:false` with an error; the process does not crash. Malformed arguments (for example `get_session_lease{sessionIds:"x"}`) answer `success:false`.
- Environment for tests: see §9. A real child must never see ambient credentials.

## 2. Commands the sidecar uses

| Command | Request | Response `data` | Notes |
|---|---|---|---|
| `get_state` | | `model{provider,id,…}`, `thinkingLevel`, `isStreaming`, `isCompacting`, `isSettled`, `hasPendingAsyncWork`, `queuedMessageCount`, `queuedMessages{steering[],followUp[],liveSteered}`, `sessionFile`, `sessionId`, `sessionName`, `todoPhases[]`, `messageCount`, `goal` (`null` or object), … | `sessionFile` is always a path, but the file may not exist (§6). `isSettled` is the §4 predicate. |
| `get_available_models` | | `{models:[{provider,id,name,reasoning,contextWindow,maxTokens,input,…}]}` | Only providers with configured auth. |
| `get_available_commands`, `get_available_thinking_levels`, `get_session_stats`, `get_context_breakdown` | | `{commands[]}`, `[levels]`, stats, `{model{provider,modelId},contextWindow,categories[{id,label,tokens}],usedTokens,freeTokens,…}` | `get_context_breakdown` is a kept patch. |
| `set_model` | `{provider, modelId}` | the model | Journals `model_change` (§6). Unknown model: `success:false`. |
| `set_thinking_level` | `{level}` | none | Journals `thinking_level_change` only if the effective level changes; clamped to the model (non-reasoning models stay `off`). |
| `prompt` | `{message, streamingBehavior?:"steer"\|"followUp", images?}` | none; or `{agentInvoked:false}` for a locally handled input | While a run is live without `streamingBehavior`: `success:false` ("Agent is already processing…"). Empty input / builtin slash commands answer `{agentInvoked:false}` with no `prompt_result`. |
| `steer`, `follow_up` | `{message}` | none | Queue behind the live run; no `prompt_result` of their own. On an idle session they start a run. |
| `abort` | | none | Response is written **after** the run's `agent_end` (§4). |
| `abort_and_restore_queue` | | `{steering:[{text}], followUp:[{text}]}` | Withdraws queued input, aborts, returns the withdrawn text. |
| `abort_and_prompt` | `{message}` | none | Abort, then run `message`. |
| `switch_session` | `{sessionPath, provider?, modelId?}` | `{cancelled}` | A path that does not exist opens a **new empty session writing there**, not an error. |
| `new_session` | `{parentSession?}` | `{cancelled}` | Creates a header-only transcript and takes the lease at once. |
| `get_messages` | | `{messages[]}` | The active branch only; after compaction the first message is a `compactionSummary`. |
| `get_entries` | `{since?}` | `{entries[], leafId}` | Append order, all branches. Unknown `since`: `code:"unknown_since"`. `leafId` is absent when the last record has no id. |
| `navigate_tree` | `{entryId}` | `{cancelled, editorText?}` | Moves the leaf in memory only (§7). Errors: `entry_not_found`, `session_busy`. |
| `fork`, `branch` | `{entryId?}` | `fork`: `{cancelled}`; `branch`: `{text, cancelled}` | New transcript; the child continues on it; read the path from `get_state.sessionFile`. `session_busy` while a run is live. |
| `compact` | | `{summary, shortSummary, firstKeptEntryId, tokensBefore, details}` | Small sessions: `success:false` "Nothing to compact (session too small)". Frames: `manual_compaction_start`, `manual_compaction_end{result,aborted}` or `{skipped,errorMessage}`. Appends a `compaction` entry. |
| `get_session_lease` | `{sessionIds[]}` | `{held[], unknown[]}` | §8. |
| `set_session_name` | `{name}` | none | |
| `get_last_assistant_text`, `set_todos`, `export_html`, `bash`, `goal{op,…}` | | as before | `goal`: see §10. |
| `set_subagent_subscription` | `{level:"off"\|"progress"\|"events"}` | `{level}` | Invalid level: `success:false`. |
| `get_subagents`, `cancel_subagent{subagentId}`, `steer_subagent{subagentId,message,hostMessageId?}` | | `{subagents[]}`, `{cancelled}`, none | §5. |
| `get_queued_prompts{subagentId?}` | | `{steering[],followUp[]}`: the queued user input, each `{text,images?,hostMessageId?}`; a subagent's entries carry text only | The queue the sidecar lists after a reload and rebuilds on adopt; `abort_and_restore_queue` entries carry `hostMessageId` too. |
| `prompt "/move <dir>"` | | `{agentInvoked:false}` | Relocates the session (R5). Failure is only visible in `command_output`. |
| `btw`, `btw_cancel`, `get_btw_history` | `{question, recordId?}`, `{recordId?}`, | `{record}`, `{cancelled}`, `{records[]}` | `/btw` side questions (§12): `recordId` continues a topic; one runs at a time; works while a run is live. |

## 3. Event frames

Per turn, in this order inside a run: `turn_start`, `message_start`/`message_end` (user), `message_start`, `message_update`*, `message_end` (assistant), `tool_execution_start`, `tool_execution_update`*, `tool_execution_end`, `message_start`/`message_end` (toolResult), `turn_end{message,toolResults}`; a tool call is followed by another turn (the model's reply to the results).

- Every `message_*` frame carries `messageId` (`msg-N`, unique per omp process, shared by the start, updates and end of one message). The user `message` has `role`, `content[]`, `attribution`, `timestamp` and, for steers, `steering:true`; it has **no `id`** (until P1).
- `message_update.assistantMessageEvent.type`: `text_start|text_delta|text_end`, `thinking_*`, `toolcall_start|toolcall_delta|toolcall_end{toolCall{id,name,arguments}}`. Deltas carry `delta` and `contentIndex`.
- `tool_execution_*`: `toolCallId`, `toolName`, `args`; `end` adds `result{content[],details?}` and `isError`.
- Assistant `message` fields the sidecar reads: `provider`, `model`, `stopReason` (`stop|toolUse|aborted|error|…`), `usage{input,output,cacheRead,cacheWrite,totalTokens,cost}`, `errorMessage`.
- `agent_start`; `agent_end{messages, isTerminal, yielded}`; `prompt_result{id, agentInvoked, status:"completed"|"aborted"|"error", sessionSettled, error?{message,retryable,code?}}`; `session_settled`; `queue_update{steering[],followUp[],liveSteered}`.
- Other frames seen and ignorable for status: `ready`, `available_commands_update`, `config_update`, `session_info_update`, `extension_ui_request` (widgets/notify), `notice`, `command_output{text}`, `goal_updated`.

## 4. The activity stretch (what "busy" means)

A **stretch** opens on `agent_start` (or a pending host-scheduled turn) and ends with exactly one `session_settled`, written after the last `agent_end` **and** the `prompt_result` frames for it, once nothing is live, admitted, queued, async, or scheduled: `isSettled = !isStreaming && queuedMessageCount === 0 && !hasPendingAsyncWork && !goalTurnScheduled`.

Recorded orders (details and full frame lists in R1):

- plain: `response agent_start turn_start user… assistant… turn_end agent_end prompt_result{completed,sessionSettled:true} session_settled`.
- follow-up/steer queued mid-turn: one `agent_start`, one `agent_end`; both prompts report afterwards; one `session_settled`. A steer is delivered at the next turn boundary, a follow-up after the model is done, so **a steer overtakes an earlier follow-up** and user entries are written in delivery order.
- `abort`: `agent_end`, then `response:abort`, then `prompt_result{aborted,…}`, then `session_settled`.
- `abort` with queued input: the stretch **strands**: `prompt_result{aborted,sessionSettled:false}`, no `session_settled`, `get_state{isStreaming:false,isSettled:false,queuedMessageCount>0}`. `abort_and_restore_queue` clears it (returning the text) but then emits no `session_settled` either; read `get_state.isSettled`.
- `abort_and_restore_queue` mid-run: one run, `prompt_result{aborted,true}` for the running and the queued prompts, one `session_settled`.
- `abort_and_prompt`: second `agent_start` before the old prompt's `prompt_result{aborted,sessionSettled:false}`; one `session_settled` after the replacement.
- Background work (`bash{async:true}`, detached `task` subagents) keeps the stretch open: `prompt_result{sessionSettled:false}`, later a wake run (`agent_start` … `message_start` role `custom`, `custom_message async-result` entry … `agent_end`), then `session_settled`.
- Locally handled prompts open no stretch and have no `prompt_result`.

A host that follows this: `active` from `agent_start` (or an accepted `prompt` with `agentInvoked` not false) until `session_settled`, or `prompt_result{sessionSettled:true}`, or `get_state.isSettled` after an abort. Goal continuations are covered by the same predicate (`goalTurnScheduled`).

**The parent's own busy period (R10, `test/contract/parent-idle.test.ts`).** A stretch can outlive the parent's run. Which kind of "not settled" it is, is readable from `get_state` alone:

| `isStreaming` | `isSettled` | `hasPendingAsyncWork` | `queuedMessageCount` | meaning |
|---|---|---|---|---|
| true | false | any | any | a run is live |
| false | false | **true** | 0 | parent idle, background work (async bash, async subagent) running; the goal, if any, waits behind it |
| false | false | **false** | 0 | a run is due: goal continuation decided, or a prompt admitted, not yet started |
| false | false | false | **>0** | stranded by a plain `abort`: nothing runs until the host acts |
| false | true | false | 0 | settled |

During the background gap there is no frame at all between `prompt_result{sessionSettled:false}` and the wake run's `agent_start`, and `idleMaintenance` is absent. A background job or subagent finishing wakes the parent with a new `agent_start` (first message `custom`, `async-result`). A goal does not continue while background work is pending; after the wake it continues only if the wake turn made progress (a tool call), otherwise the stretch settles with the goal still `active`. Between two goal turns `agent_end` and the next `agent_start` are adjacent frames; `session_settled` is written once, after the last.

## 5. Subagents

The `task` tool runs subagents inside the parent process and detaches them (`detached:true`): the call returns `Spawned agent …` at once. With `set_subagent_subscription{level:"events"}` the parent's stream carries:

- `subagent_lifecycle{payload{id,agent,agentSource,status:"started"|"completed"|"failed"|"aborted",index,description?,sessionFile,parentToolCallId,detached}}`;
- `subagent_progress{payload{index,agent,task,assignment,parentToolCallId,detached,sessionFile,progress{id,status:"running"|"completed"|…,toolCount,requests,tokens,durationMs,recentTools,recentOutput,…}}}`;
- `subagent_event{payload{id,event}}` with the child's full session event (`agent_start`, `turn_start`, `message_*` (full snapshots, not deltas), `tool_execution_*`, `turn_end`, `agent_end`).

Order: parent yields (`prompt_result{sessionSettled:false}`), then `started`, events/progress, `completed`, then the parent's wake run and `session_settled`. The artifact transcript is `<parent transcript without .jsonl>/<id>.jsonl` with its own `type:"session"` header (the child's session id). `get_subagents` lists only running children; finished ones disappear. `steer_subagent` on a running child succeeds; on an unknown or finished id it fails. `cancel_subagent` ends it as `aborted`. See R9-subagents.md for abort semantics.

## 6. Transcript files

`$PI_CODING_AGENT_DIR/sessions/<bucket>/<timestamp>_<uuid>.jsonl`; bucket = `-<relative path>` under `$HOME`, `-tmp-<relative>` under the temp root, `--<absolute>--` elsewhere (`/`, `\`, `:` → `-`).

- Line 1: 256-byte `{"type":"title",…,"pad":…}` slot. Line 2: `{"type":"session","version":3,"id","timestamp","cwd","parentSession"?,"previousSessionFiles"?}`. Then entries `{type,id,parentId,timestamp,…}`: `message`, `custom`, `custom_message`, `model_change{model:"provider/id",role,resolvedModelIsFallback}`, `thinking_level_change{thinkingLevel,configured}`, `compaction`, … The conversation is the path from the **last line's id** back to the root.
- **When the file exists.** A fresh process knows its path but writes nothing until the history contains an assistant message; `set_model`, `set_thinking_level` and the user message are held in memory until then. `new_session`, `fork`, `branch` and `switch_session` to a missing path create the file at once. A crash between prompt and first assistant message loses the user message.
- **Sidecar records rule.** omp loads every JSON line it finds. A line without an `id` becomes an entry with no id: the leaf is undefined and the history is empty (`get_entries.leafId` absent, `get_messages` empty). A foreign record that carries `id` and `parentId: <current leaf>` would extend the branch, but any line the sidecar appends races omp's own appends. Therefore the sidecar writes **nothing** to omp's files (PLAN rule 2); its own data lives in `SessionDoc`. Legacy `.jsonl.oc` content is imported once and the old files renamed.
- `fork` file: same bucket, header `parentSession` = the **parent's file path** (not id), root-to-target entries with their original ids/parentIds.
- Compaction is append-only: older ids stay valid for `get_entries{since}`; `unknown_since` happens only for an id that is not in the current session (another session, or before `new_session`/`switch_session`).

## 7. Tree navigation (revert/redo)

`navigate_tree` changes the leaf **in memory** and writes nothing. Reverting to a user message makes its parent the leaf and returns its text as `editorText`; redo is `navigate_tree` back to the abandoned leaf. A second process opening the file before the next append still sees the old last line as the leaf. The next prompt is journaled under the new leaf; the abandoned branch stays in the file and in `get_entries`. A runtime that dies before the next append loses the revert: re-apply it from `SessionDoc.revert` when a runtime is created.

## 8. Leases and ownership

- `get_session_lease{sessionIds}` → `{held, unknown}`: whether any process (the caller included) holds each session's ownership lease. Linux: abstract unix socket keyed by the lease path (`PI_TEST_SESSION_OWNERS_DIR`/state dir + session id from the header). Probe cost: ~0.07 ms warm, 0.3 ms cold, on a child that has no session open.
- A lease is taken by the first write (first assistant message) or by `new_session`/`fork`/missing-path `switch_session`, released when the process exits (SIGKILL included).
- **Open-but-unwritten gap:** a process that opened an existing session and has written nothing holds no lease; the probe says free.
- A second process that writes a session another process holds moves to a sibling transcript (new id, `parentSession`) rather than writing the owner's file; this is what P3 `claimLease` turns into a refusal.
- `/move` is refused while another live process writes the session ("Nothing was moved.").

## 9. Test environment (credential isolation, mandatory)

`test/contract/harness.ts`: the child gets exactly `PATH`, `HOME`, `PI_CODING_AGENT_DIR`, `XDG_{CONFIG,STATE,DATA}_HOME`, `TMPDIR` (all under a fresh directory below `/hdd/brute/tmp`), `PI_SKIP_VERSION_CHECK`, `PI_TEST_SESSION_OWNERS_DIR` and `OMP_STUB_*`. `models.yml` declares one provider, `fake` (`openai-completions`, `http://127.0.0.1:<port>/v1`, `apiKey: dummy`), served by `test/contract/fake-provider.ts` (scripted streaming chat-completions). At spawn the harness asserts `get_available_models` lists only `fake/*` and aborts the child otherwise. Run:

```
bun test test/contract                         # stub (default)
CONTRACT_OMP=real bun test test/contract       # real omp from /hdd/brute/projects/oh-my-pi
```

## 10. Goal mode

omp's goal is driven by the sidecar's `/goal` command: `goal{op:"create"|"resume"|"pause"|"drop"|"get", objective?, token_budget?}`. The child runs with `goal.continuationModes: [rpc]` so omp schedules continuation turns itself; the stretch stays open while one is pending (`isSettled:false`, §4). Continuation turns have no `prompt_result`; a turn with no new tool activity stops the sequence and the stretch settles with the goal still `active`. The agent completes the goal with its `goal` tool (`{op:"complete"}`); afterwards `get_state.goal` is `null`, and the transcript keeps the record: every change is a `mode_change` (`goal` / `goal_paused` with `data.goal`, `none`), a completion `none` then a `custom` `goal-completed` entry (`objective`, `tokensUsed`, `tokenBudget`). `goal_updated` frames are not read. Pinned by `test/contract/parent-idle.test.ts`.

## 11. The local branch's patches (P1–P6)

Each patch is one commit on `local`; `test/contract/{host-message-id,custom-entry,claim-lease,idle-maintenance,resume,cli}.test.ts` run against the stub and the real omp. The stub behaves the same way for everything stated here.

### 11.1 P1: `hostMessageId`

`prompt`, `steer`, `follow_up`, `abort_and_prompt` accept `hostMessageId` (non-empty string). It is stored on the journaled user message, `entry.message.hostMessageId` (also in `get_messages`, on disk, after reload and in a fork), and echoed on that message's `message_start`/`message_end` (`frame.message.hostMessageId`). Behaviour:

- It is on the user message only (never on the assistant or tool messages) and is never sent to the model.
- Every delivery path carries it: a prompt that starts a run, `steer`/`follow_up`/`prompt{streamingBehavior}` queued mid-run (journaled in delivery order, a steer still has `steering:true`), `steer`/`follow_up` that start a run on an idle session, and the replacement of `abort_and_prompt`.
- An empty or non-string value is refused before anything happens: `success:false`, `error:"hostMessageId must be a non-empty string"` (no `code`, no frames, nothing journaled).
- A prompt without an id carries none. `[source only]` Locally handled input (slash commands that do not become a plain user message) carries none; `/move` journals nothing.

### 11.2 P2: `append_custom_entry`

`{type:"append_custom_entry", customType, data?}` → `{entryId}`. The entry is `{type:"custom", customType, data?, id, parentId, timestamp}` appended on the current branch (parent = current leaf; it becomes the leaf), written to the transcript like any entry, and never sent to the model (`get_messages` does not grow). `data` is any JSON value and optional (the key is absent when omitted). An empty or non-string `customType` fails with `customType must be a non-empty string`. On a session that has produced no assistant message yet the entry waits in memory with the rest of the journal (no file, §6).

After `navigate_tree` (which moves the leaf in memory only, §7) the appended entry is parented on the new leaf and is the file's last line, so the branch choice is durable and visible to other processes (PLAN §3.9 `host-revert`).

### 11.3 P3: `switch_session {claimLease:true}`

- A free session: success `{cancelled:false}`; its lease is held **from the open**, before any write (a probe from another process says held; compare the stock "open-but-unwritten gap", §8). The first write goes to the same file and session id, never a sibling transcript.
- A session another live process owns: `success:false`, `code:"session_busy"`, `error:"Session is owned by another omp process"`. The refusal happens before anything is torn down: the current session id/file, a live run (it completes normally, `prompt_result` completed) and its queue are untouched, and the owner keeps its lease.
- A path that is missing or has no readable session header: `success:false`, `error` contains `No session found at <path>`, **no `code`**. (Without `claimLease`, a missing path still opens a new empty session, §2.)
- Without the flag nothing changes: the switch opens a session another process owns, and takes the lease at the first write.
- Leaving a session gives up its lease: `switch_session` (to another session), `new_session` and `fork` release the previous session's lease (`branch` takes the same path `[INFERENCE]`); the process exiting or dying releases whatever it still holds. The next claimer then succeeds.

### 11.4 P4: `get_state.idleMaintenance` and the `recap` frame

- `get_state.idleMaintenance: {recapDueAt?: number, compactionDueAt?: number}` (epoch ms) is present only while idle work is owed **and scheduled**, absent otherwise (key not present, not `null`): before the first turn, while a run streams, during a background-work gap (§4) and after the work has been done. A recap becomes owed when a run ends on a generated assistant message and is armed once the stretch has settled; `recapDueAt` is that moment plus the delay (`recap.idleSeconds`, default 240, clamped to 1–3600; `recap.enabled` default true). `[source only]` The field stays, with `recapDueAt` = the start time, while the recap request runs. `compactionDueAt` appears only when idle compaction applies (`compaction.idleEnabled`, context over `compaction.idleThresholdTokens`; `[source only]`, the contract rig never reaches the threshold).
- The result is a frame `{type:"recap", recap: string, createdAt: number}` (`createdAt ≥ recapDueAt`), at most once per stretch, after which `idleMaintenance` disappears. It is not a transcript entry (`get_entries` does not change; omp journals it to `history.db`). `set_event_filter` does not drop it.
- New activity (`agent_start`, a session switch) supersedes an owed recap; the next stretch re-arms its own. A prompt inside the delay therefore yields one recap, after the newer stretch settles.
- **Release rule for a host that recycles idle children:** release only when `isSettled` is true **and** `idleMaintenance` is absent; with omp's defaults that is at least 240 s after the last turn.
- Stub: off by default; `OMP_STUB_RECAP_MS=<ms>` arms the recap that long after the stretch settles (text `Stub recap: <n> messages in context.`). The contract rig sets omp's `recap.idleSeconds` and the stub's `OMP_STUB_RECAP_MS` together (`Rig({recapSeconds})`).

### 11.5 P5: `resume {subagentId?, hostMessageId?}`

The TUI's `.`: `AgentSession.resume()` on the session or on the subagent `subagentId`. **No user message is journaled** and there is no `prompt_result`.

- With `hostMessageId` a `custom` entry `{customType:"host-resume", data:{hostMessageId, text:"."}}` is journaled first, in the target's own transcript (a subagent's artifact file for `subagentId`); the model never sees it. It stays when nothing could be resumed.
- **Idle session** with an answered conversation: a hidden directive runs a new turn: `agent_start`, `message_start/end` with `role:"developer"`, `synthetic:true`, `userInitiated:true` (text starts `<system-notice>\nContinue.`; journaled as a `message` entry), an assistant reply, `agent_end`; **then** `response:resume`, then `session_settled`. The conversation tail is the assistant message that follows the marker.
- **Unanswered prompt** (an abort or failure cut the turn off before any text or tool call): the prompt runs again as it was; no directive, no new message. The response comes right after `agent_start`, before the first `turn_start`; the run is still live (`resume` does not wait for it).
- **Streaming session**: interrupted as Esc would (the assistant message ends `stopReason:"aborted"`, `agent_end`), the marker is journaled before the aborted assistant entry, the old prompt reports `prompt_result{aborted, sessionSettled:false}`, then the continuation runs (a second `agent_start`, the developer directive), and `response:resume` follows its `agent_end`. One `session_settled` closes the whole stretch. `[source only]` Input queued behind the run continues the run in place of the directive.
- Errors (all `success:false`, no `code` except where stated): `Nothing to resume` (no user turn or compaction in the conversation; marker kept), `hostMessageId must be a non-empty string`, `` `subagentId` must be a non-empty string. ``, `Unknown subagent or session file unavailable: <id>`; `[source only]` `code:"session_busy"` when another turn claims the session between the interrupt and the continuation.
- **Subagent**: a running one is interrupted and continued (its transcript: `user`, `custom host-resume`, `assistant` aborted, `developer` directive, `assistant`); `response:resume` comes at once; it then completes (`subagent_lifecycle completed`) and wakes the parent. A finished one that is still registered (also a cancelled one) is revived: `subagent_lifecycle started` precedes the response, then `completed`, the marker and directive are appended to its transcript, and the parent wakes again.

### 11.6 P6: the one-shot CLI

All three run in a fresh process, take no lease and write nothing (transcripts, lease directory and mtimes are byte-identical before and after, also while another omp owns the session). Failures print `error: <message>` on stderr, nothing on stdout, exit code 1.

- `omp session inspect --json <path|id>`: normal startup against a read-only open. Output (one JSON line):
  `{sessionId, title: string|null, model: {provider, modelId}|null, modelFallback?: {requested: string|null, reason}, thinkingLevel: string|null, contextBreakdown: {model, contextWindow, categories[{id,label,tokens}], usedTokens, autoCompactBufferTokens, freeTokens, thresholdTokens}|null, contextBreakdownReason?, availableCommands[], todoPhases[], goal: object|null, leaseHeld: boolean|null}`.
  - `categories` ids in order: `systemPrompt, systemTools, systemContext, instructionFiles, skills, messages` (the same as `get_context_breakdown`; `thresholdTokens = contextWindow − autoCompactBufferTokens`); `availableCommands` is `get_available_commands`' list.
  - `thinkingLevel` is `null` for a model without reasoning, otherwise the journal's latest `thinking_level_change` or the model default (`"high"` in the rig).
  - A saved model that cannot be restored does not fail the call: `model` is the one omp selected and `modelFallback = {requested: "provider/id", reason: "Could not restore model fake/gone. Using fake/fast"}`. With no model available at all: `model: null`, `modelFallback.reason` ends with `No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.` (`requested: null` when the session saved none), `contextBreakdown: null`, `contextBreakdownReason: "no model is selected for this session"`, `thinkingLevel: "high"`.
  - `leaseHeld` is probed before startup: `true` while a running omp owns the session.
  - Errors: `Session file not found: <path>`; `Cannot resume session "<path>": the session header is missing or malformed. The file was not modified.`; `Directories cannot be read like files`; without `--json`: `inspect only prints JSON. Usage: omp session inspect --json <session>`. A bare id is accepted in place of a path.
  - Cost: ~0.8 s real (startup of the whole agent runtime); instant in the stub.
- `omp session lease --json -- <id>…` → `{"held":[…],"unknown":[…]}`, the same answer as `get_session_lease` without a child (~0.2 s). `--` keeps ids starting with `-` from parsing as flags; no id: `Missing session id. Usage: omp session lease [--json] -- <session-id>...`.
- `omp models --json` → `{"models":[{provider, kind:"chat", id, selector:"provider/id", name, contextWindow, maxTokens, reasoning, thinking: string[]|null, input[], cost{input,output,cacheRead,cacheWrite}, pricingStatus}]}`; `thinking` lists the supported levels for a reasoning model (`minimal, low, medium, high, xhigh`), `null` otherwise. With no provider configured: `{"models":[]}`, exit 0. ~1.5 s real.

## 12. `/btw` side questions (`test/contract/btw.test.ts`)

`btw {question}` answers a question beside the conversation: an ephemeral turn on a snapshot of the session, **no `agent_start`/`turn_start`/`message_*` frames, no transcript entry, no change to `get_state.isSettled`**, and it may be asked while a run streams. Frame order: `btw_record` (the topic, latest turn `status:"running"`, `answer:""`), the `btw` response `{record}`, `btw_delta{recordId, delta}`*, then a terminal `btw_record` (`complete`, or `cancelled`/`error` with `error`). A second `btw` while one runs fails (`A /btw question is still running; cancel it first`); `btw_cancel` ends the running one as `cancelled`; an empty question fails (`btw requires a non-empty question`).

Every turn is checkpointed into `<session file without .jsonl>/btw-history/entry-<id>.json` (no `sessions/<scope>` level for the main session): `{id, leafId, question, answer, status, createdAt, updatedAt, error?, followUps?}`, `leafId` being the transcript leaf the topic was asked at (`null` before any entry). Streamed text is not checkpointed: a record left `running` belongs to a process that died. The sidecar only reads this store (`src/omp/btw-history.ts`) and shows each turn as `/aside <question>` + the answer, after the entry `leafId` names.
