# oh-my-pi (omp) RPC contract

What the sidecar may rely on when it drives `omp --mode rpc`. Every statement here is pinned by `test/contract/` (run against the pinned real omp build and the stub) unless marked `[INFERENCE]` or `[source only]`. Evidence and omp source citations: `docs/research/R1.md` … `R7.md`, `R9-subagents.md`. Command and frame names come from omp's `modes/rpc/rpc-mode.ts`, `rpc-types.ts` and `docs/rpc.md`.

Pinned omp: the `local` branch of `oh-my-pi-local` (upstream dca23990ad + kept patches; protocol version 1 announced, versions 1 and 2 supported). P1–P5 (PLAN §3.13) are not covered here.

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
| `get_subagents`, `cancel_subagent{subagentId}`, `steer_subagent{subagentId,message}` | | `{subagents[]}`, `{cancelled}`, none | §5. |
| `prompt "/move <dir>"` | | `{agentInvoked:false}` | Relocates the session (R5). Failure is only visible in `command_output`. |

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

A host that follows this: `active` from `agent_start` (or an accepted `prompt` with `agentInvoked` not false) until `session_settled`, or `prompt_result{sessionSettled:true}`, or `get_state.isSettled` after an abort. `[source only]` Goal continuations are covered by the same predicate (`goalTurnScheduled`).

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
CONTRACT_OMP=real bun test test/contract       # real omp from /hdd/brute/projects/oh-my-pi-local
```

## 10. Goal mode

OpenChamber's goal record is served by omp's own goal: `goal{op:"create"|"resume"|"pause"|"drop"|"get", objective?, token_budget?}`; `goal_updated{goal,state}` frames mirror status (`complete`, `budgetLimited`, tokens). The child runs with `goal.continuationModes: [rpc]` so omp schedules continuation turns itself; the stretch stays open while one is pending. Not covered by the contract tests (R1 "Not recorded").
