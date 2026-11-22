# oh-my-pi (omp) RPC Protocol Reference

This document outlines the standard I/O RPC protocol spoken by `oh-my-pi` (`omp`) and how `omp-openchamber-server` interacts with it.

---

## 1. Process Invocation & Transport

OMP is invoked as a subprocess in RPC mode:
```bash
omp --mode rpc --cwd <directory> --no-title --no-pty
```

- **Transport**: Newline-delimited JSON (NDJSON) over standard `stdin` / `stdout`.
- **Command Framing**: The host writes JSON commands to `stdin` ending with `\n`.
- **Response / Event Framing**: OMP writes responses and asynchronous events to `stdout` ending with `\n`.

### Subprocess Lifecycle & Resilience
- **Process Groups**: The subprocess is launched detached in its own process group (`setpgid`). On termination, the entire process tree (including any spawned language servers or tools) is sent `SIGTERM`.
- **Readiness Probing**: Rather than waiting for the optional `ready` frame (which can be delayed by project LSP or update checks), the server sends a `get_state` probe immediately and marks the process ready upon the first valid response frame.
- **Environment Overlays**:
  - `PI_SKIP_VERSION_CHECK=1`: Disables startup network update checks.
  - `--config {"mcp":{"enableProjectConfig":false}}`: Prevents third-party project MCP server hangs on embedded helper instances.

The sidecar separately checks the latest stable OMP release after startup and every four hours. This check only reports availability; updating remains a deliberate pin change so active OMP sessions are not replaced underneath the server. After `ompVersion` is bumped in `package.json`, the next sidecar startup automatically stages that exact version.

---

## 2. Core RPC Commands

Commands sent to OMP `stdin` take the shape `{"type": "<command>", "id": "<correlationId>", ...}`.

| Command | Arguments | Description |
|---|---|---|
| `get_state` | `{}` | Returns full agent state, current model, thinking level, and tool definitions. |
| `get_available_models` | `{}` | Returns the configured provider catalog and available models. |
| `prompt` | `{"prompt": string, "streamingBehavior": "steer"\|"followUp"}` | Enqueues a turn prompt. Returns acknowledgment immediately; streaming chunks arrive as events. |
| `set_model` | `{"provider": string, "model": string}` | Switches the active model. |
| `set_thinking_level` | `{"level": "off"\|"low"\|"medium"\|"high"}` | Configures model reasoning intensity. |
| `switch_session` | `{"sessionPath": string}` | Switches the active session to the given JSONL transcript path. |
| `new_session` | `{"parentSession"?: string}` | Starts a new session or forks from a parent session. |
| `abort` | `{}` | Requests immediate interruption of active turn generation. |

### Goal mode

OpenChamber's goal (`metadata.openchamber.goal`) is served by omp's own goal, not by OpenChamber's audit loop. A `PATCH /session/:id` that arms, pauses, resumes or clears the record becomes an RPC `goal` command (`create`/`resume`/`pause`/`drop`, `src/adapters/openchamber/goal.ts`). The embedded child runs with `goal.continuationModes: [rpc]`, so omp starts each goal turn itself and the agent ends the goal by calling its `goal` tool. The sidecar keeps the session busy until omp settles, which keeps OpenChamber's loop (it only acts on an idle session with an active goal) from auditing or prompting. omp's `goal_updated` events are mirrored back into the record: `complete` ("reported by agent"), `budgetLimited`, token use, and `blocked` when omp stops continuing with the goal still open. OpenChamber's briefing synthetic reminder, which tells the agent its last message is judged by an independent check, is dropped from the prompt.

---

## 3. Event Vocabulary

During turn execution, OMP emits event frames on `stdout`:

### Streaming Turns (`message_update`)
Turn text and reasoning are delivered inside nested `assistantMessageEvent` payloads:
- `text_start` / `text_delta` / `text_end`: Incremental output text chunks.
- `thinking_start` / `thinking_delta` / `thinking_end`: Extended reasoning / thinking blocks.
- `toolcall_start` / `toolcall_delta` / `toolcall_end`: In-flight tool invocation parameters.

### Tool Execution
- `tool_execution_start`: Emitted when a tool begins execution (`{toolCallId, name, input}`).
- `tool_execution_update`: Periodic progress updates during long-running tool calls.
- `tool_execution_end`: Emitted when execution concludes (`{toolCallId, output, isError}`).

### Turn Lifecycle
- `agent_start`: Agent turn initiated.
- `agent_end`: Turn execution finished (`{isTerminal: boolean, messages: [...]}`).
- `prompt_result`: Final result frame echoing `agentInvoked` status.

---

## 4. Session Disk Schema

OMP stores session transcripts under:
```
~/.omp/agent/sessions/<cwd-slug>/<timestamp>_<uuidv7>.jsonl
```

- **Path Slug**: omp's bucket name for the canonical (realpath) cwd: `-<relative>` under `$HOME` (`/home/me/git/x` → `-git-x`), `-tmp-<relative>` under the temp root, and `--<absolute>--` for anything else (`/srv/x` → `--srv-x--`), with `/`, `\` and `:` turned into `-`. The sessions root is `$PI_CODING_AGENT_DIR/sessions`, default `~/.omp/agent/sessions`. `src/providers/omp/paths.ts` mirrors this.
- **Tree**: entries carry `id`/`parentId`; the conversation is the path from the last entry back to the root, so branches abandoned by `/tree` or an edit stay in the file but are not shown.
- **Leases and forks**: a process owns a session while it lives. A second process that writes it moves to a sibling file (new id, `parentSession` pointing back). When OpenChamber's child does this, the sidecar records an `oc_alias` carrying the OpenChamber session id for the sibling, and that id continues there. An idle child is released after `OC_CHILD_IDLE_MS` (default 120000) so a terminal omp can take the session over without forking. `parentSession` is lineage only; just artifact sub-sessions are children.
- **Sidecar records**: everything the sidecar itself records about a session (`oc_alias`, `oc_notice`, `agent_change`, `model_change`, `revert_change`, `metadata`, `archive`, `viewed`) lives in `<session>.jsonl.oc`, never in omp's transcript. omp replays the transcript as a tree whose active leaf is the last line's `id`; a line without an `id` leaves the leaf undefined and the next child to load the file sees an empty history. `src/providers/omp/oc-records.ts` owns the file and moves such lines out of transcripts older sidecars wrote them into, before a child loads one.
- **File Format**: Append-only (or state-rewritten) JSON Lines.
- **Header Line**: The first line contains a `type: "session"` metadata object:
  ```json
  {"type":"session","id":"019f65f9-fa21-7000-892d-b00212c6d038","cwd":"/path/to/project","timestamp":"2026-08-24T12:00:00.000Z","version":1}
  ```
- **Entry Lines**: Each subsequent line contains a turn entry (`message`, `user`, `assistant`, `custom`) chained via `parentId`.
- **Title Slot**: A fixed 256-byte header slot is maintained for session title updates.
