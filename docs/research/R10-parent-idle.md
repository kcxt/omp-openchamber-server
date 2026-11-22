# R10: what the parent reports while background work runs and between goal turns (PLAN §3.1)

Recorded against the patched omp (`local` branch, `2e7b51fda2`) through `test/contract/` (hermetic env, fake provider only), and held against the stub by the same test (`test/contract/parent-idle.test.ts`, `CONTRACT_OMP=stub|real`). Source citations are under `packages/coding-agent/src/` of `/hdd/brute/projects/oh-my-pi-local`.

## Answer

`get_state` tells these apart with four fields. Nothing else is needed (`goal` only names which kind of run is due).

| Parent state | `isStreaming` | `isSettled` | `hasPendingAsyncWork` | `queuedMessageCount` | `goal.goal.status` |
|---|---|---|---|---|---|
| a run is live | `true` | `false` | any | any | any |
| **idle, background work running** (async bash, async subagent) | `false` | `false` | **`true`** | `0` | any, `active` included |
| **a run is due**: goal continuation decided, not yet admitted (or a prompt admitted, not yet started) | `false` | `false` | **`false`** | `0` | `active` for a goal continuation |
| stranded stretch (plain `abort` left queued input; nothing will run until the host acts) | `false` | `false` | `false` | **`>0`** | any |
| settled | `false` | `true` | `false` | `0` | any |

Why this is exact, from source: `isSettled = !isStreaming && !hasAdmittedSubmission && queuedMessageCount === 0 && !hasPendingAsyncWork() && !goalTurnScheduled` (`session/session-settle.ts:isSessionSettled`, used at `modes/rpc/rpc-mode.ts:2380`). `get_state` exposes every term except `hasAdmittedSubmission` and `goalTurnScheduled`. So `!isStreaming && !isSettled && !hasPendingAsyncWork && queuedMessageCount === 0` can only be one of those two hidden terms: **a run omp has already decided to start** (a goal continuation, `RpcGoalController.continuationPending`, or an admitted prompt whose `agent_start` has not been written yet).

Rule for PLAN §3.1 (the one sentence it needs): **`active` ⇔ `isStreaming` or (`!isSettled && !hasPendingAsyncWork && queuedMessageCount === 0`); `idle` ⇔ `!isStreaming && hasPendingAsyncWork` (background running) or `isSettled`.** `hasPendingAsyncWork` wins: while it is `true` the parent is idle even if a goal is `active` (see §3, omp holds the continuation back until the background work has delivered). `queuedMessageCount > 0` with nothing streaming and no async work is the stranded stretch (R1): not a due run. The sidecar must not call it `active` forever; treat it as `idle` with queued items the host still owns (D3 `abort_and_restore_queue` clears it).

The due window is short. After `goal create` on an idle session it is about 15 ms (state samples at 8 ms showed it, `agent_start` at ~20 ms); between two goal turns `agent_end` and the next `agent_start` are adjacent in the stream and a `get_state` could not be slotted between them in any recording. A host that polls therefore sees the due state mainly after `goal create`/`resume`; between turns it must treat "no `session_settled` yet, goal `active`, no async work" as busy, which is what the rule above gives.

## Recordings (real omp; `[state@ms]` is a `get_state` snapshot taken back to back, `stream settled async queued`)

### (a1) async bash while the parent run has ended

Script: prompt → text, `bash{async:true, command:"sleep 2; echo job-done"}`, text.

```
response:prompt
   [state@8ms]    stream=1 settled=0 async=0 queued=0
agent_start  turn_start  message_start:user  message_end:user  message_start:assistant  message_end:assistant
tool_execution_start  tool_execution_end  message_start:toolResult  message_end:toolResult  turn_end
   [state@63ms]   stream=1 settled=0 async=1 queued=0      <- the job is already pending inside the parent's own run
turn_start  message_start:assistant  message_end:assistant  turn_end
agent_end
prompt_result{agentInvoked:true,status:completed,sessionSettled:false}
   [state@81ms]   stream=0 settled=0 async=1 queued=0      <- THE GAP: parent idle, stretch open (identical for 2.0 s, no frame at all)
agent_start                                                  <- job finished: omp wakes the parent
   [state@2100ms] stream=1 settled=0 async=0 queued=0
turn_start  message_start:custom  message_end:custom  message_start:assistant  message_end:assistant  turn_end
agent_end
session_settled
   [final]        stream=0 settled=1 async=0 queued=0  idleMaintenance present (recap armed only now)
```

### (a2) async subagent (`task` tool), `set_subagent_subscription events`

Same shape. After `prompt_result{sessionSettled:false}`: `subagent_lifecycle:started`, interleaved `subagent_event`/`subagent_progress` (the child's turns, 2 s of `sleep`), `subagent_lifecycle:completed`, then `agent_start` (wake, `message_start:custom`), `agent_end`, `session_settled`.

```
   [state@38ms]   stream=0 settled=0 async=1 queued=0      (held for the whole 2 s; get_subagents lists the child as `running`)
   ...lifecycle started, subagent_event*, subagent_progress*, lifecycle completed...
agent_start
   [state@2088ms] stream=1 settled=0 async=0 queued=0
   ...wake run...  agent_end  session_settled
   [final]        stream=0 settled=1 async=0 queued=0
```

`idleMaintenance` is **absent during the whole gap** in both (a1) and (a2) (omp arms recap/compaction only after settlement, `session/idle-maintenance.ts:#armWhenQuiet` waits on `waitForSessionSettlement`). It appears after the stretch settles.

### (b) goal continuation: the gap between goal turns

Goal created on an idle session; turn 1 makes progress (a tool call), turn 2 completes the goal with the `goal` tool. Config `goal.continuationModes: [rpc]` (the sidecar's own setting; the harness sets it).

```
goal_updated  response:goal
   [state@8ms]    stream=0 settled=0 async=0 queued=0 goal=active     <- continuation due: decided, not admitted
agent_start
   [state@22ms]   stream=1 settled=0 async=0 queued=0 goal=active
turn_start message_start:custom(goal context) message_start:custom(hidden steer) ... bash call/result ... turn_end  turn_start ... turn_end  goal_updated
agent_end
agent_start                                                          <- adjacent: no state could be sampled in between
turn_start ... goal tool call ... goal_updated ... turn_end
agent_end
   [state@129ms]  stream=0 settled=1 async=0 queued=0 goal=(none)     <- completed
session_settled
```

Facts the sidecar relies on:

- No `prompt_result` for goal turns (they have no prompt). One `session_settled` for the whole sequence, last frame. A goal turn that makes no progress (empty or repeating tool activity, `goalContinuationActivity`) stops the sequence: the stretch then settles with the goal still `active` (default echo turn: 1 turn, `session_settled`, `goal.status = active`).
- `session_settled` is never emitted between goal turns, and `get_state.isSettled` was `false` in every sample before the final one.
- Several busy → idle pairs inside one stretch are real: every goal turn is its own `agent_start … agent_end`.

### (c) goal `active` while background work runs

Goal turn 1: text, `bash{async:true, sleep 2}`, text.

```
goal_updated  response:goal
   [state@8ms]    stream=0 settled=0 async=0 queued=0 goal=active     (due)
agent_start  ...tool call... 
   [state@67ms]   stream=1 settled=0 async=1 queued=0 goal=active
...  goal_updated  agent_end
   [state@86ms]   stream=0 settled=0 async=1 queued=0 goal=active     <- idle; the continuation does NOT start while the job runs
agent_start                                                          <- ~2.0 s later: the job's wake (one custom message, no goal steer)
   [state@2108ms] stream=1 settled=0 async=0 queued=0 goal=active
...wake run...  goal_updated  agent_end
   [state@2223ms] stream=0 settled=1 async=0 queued=0 goal=active
session_settled
```

omp holds the goal continuation back while background work is pending (recorded: 2 s with no `agent_start`). `[INFERENCE]` The mechanism is `RpcGoalController#scheduleContinuation` awaiting `session.waitForIdle()` (`modes/rpc/rpc-goal.ts`) behind the job; not traced further. After the wake the sequence depends on what the wake turn did:

- wake with tool progress → the goal continues at once (recorded: wake turn ran a tool, next frame `agent_start` with the two goal custom messages, then the goal tool completed it);
- wake that made no progress (text only) → no further turn; the stretch settles with the goal still `active`. This is the "settled but goal active" case PLAN §3.8 maps to `blocked`.

### (d) stranded stretch (already pinned by R1, repeated by the new test)

`prompt` (slow) + `follow_up` queued + plain `abort`: `stream=0 settled=0 async=0 queued=1`, one `agent_start`, no `session_settled`. A run is not due; omp waits for the host.

## What the stub does

`test/stub-omp/omp` reproduces (a)–(d); `test/contract/parent-idle.test.ts` runs the same assertions against both. Two stub corrections came out of this record:

- the stub no longer starts a goal continuation while async work is pending (it used to run the next goal turn straight away);
- a background wake with no tool progress ends the goal's run of turns like a no-progress continuation (omp stopped after a text-only wake).

Stub timing differs in size only: the goal "due" window is 30 ms (omp ~15 ms after `goal create`, microseconds between turns).

## Consequences for PLAN §3.1 / §3.5

1. The sentence "`get_state.isSettled === false` with `hasPendingAsyncWork === false` and nothing streaming" is correct as written **provided `queuedMessageCount === 0` is added**: with queued input and nothing running the stretch is stranded, not due.
2. `hasPendingAsyncWork === true` with nothing streaming is the "parent idle, background work running" state, also when a goal is `active`. Do not reopen a busy period for it; the child sessions and `/experimental/job` carry the background work.
3. A run starts again with a plain `agent_start` in all cases (wake, goal continuation); the runtime needs no other signal.
4. `idleMaintenance` is absent for the whole background gap, so the idle-release rule (§3.2: `idle && isSettled && no idleMaintenance`) cannot release a child that still has background work, by `isSettled` alone.
