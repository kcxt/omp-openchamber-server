# API Reference

`omp-openchamber-server` exposes an OpenCode-compatible HTTP and Server-Sent Events (SSE) API on port `4096` (configurable via `OC_SIDECAR_PORT`).

OpenCode's `x-opencode-directory` request header is accepted as a URI-encoded
directory scope. A `directory` query parameter takes precedence when both are
present.

---

## Health & System

### `GET /health` · `GET /global/health`
Returns proxy health status.

**Response `200 OK`**:
```json
{
  "healthy": true,
  "status": "ok"
}
```

### `GET /api/info`
Returns OpenCode-compatible server identity information for clients that use
this endpoint as their readiness probe. OpenChamber accepts only a `2.x`
semver at or above 2.2.4 here, so `version` reports the OpenCode API level the
sidecar implements; the OMP runtime behind it is reported as `ompVersion`.

**Response `200 OK`**:
```json
{
  "version": "2.2.4",
  "ompVersion": "18.2.8",
  "pid": 12345,
  "urls": ["http://127.0.0.1:4096"],
  "paths": { "tmp": "/tmp" }
}
```

### `GET /path`
Returns resolved path information for the given directory.

- **Query Parameters**: `directory` (string, optional)
- **Response `200 OK`**:
```json
{
  "home": "/Users/username",
  "state": "/Users/username/.omp",
  "config": "/Users/username/.omp",
  "worktree": "/path/to/project",
  "directory": "/path/to/project"
}
```

### `GET /location`
Returns the resolved directory and project identity for the active location.
The sidecar exposes its current directory as the global project.

- **Query Parameters**: `directory` (string, optional)
- **Response `200 OK`**:
```json
{
  "directory": "/path/to/project",
  "project": {
    "id": "global",
    "directory": "/path/to/project",
    "canonical": "/path/to/project"
  }
}
```

### `GET /project`
Returns active project workspace metadata.

- **Query Parameters**: `directory` (string, optional)
- **Response `200 OK`**:
```json
{
  "id": "proj_default",
  "worktree": "/path/to/project",
  "directory": "/path/to/project",
  "time": {
    "created": 1756000000000,
    "updated": 1756000000000
  }
}
```

### `GET /api/projects/:projectId/config`
Returns an empty OpenChamber project setup for a path-based project ID. The
OMP sidecar does not own OpenChamber project settings, so worktree setup
commands and project actions are not configured through this endpoint.

**Response `200 OK`** includes:

```json
{
  "trust": { "hash": null, "trusted": true },
  "setupWorktree": [],
  "setupWorktreeWait": false,
  "projectActions": [],
  "draftStarters": [],
  "shared": { "status": "missing" },
  "personal": { "setupWorktreeMode": "append" }
}
```

`PUT /api/projects/:projectId/config` and the `/shared` variant return
`501 Not Implemented` because the sidecar does not persist those settings.

## OpenChamber project context

The sidecar implements the OpenChamber-owned project context API so the UI can
connect directly to it. A project ID is the path-derived value
`path_<base64url(project path)>`.

### `GET /api/project-context/:projectId`

Returns the project's notes, todos, plans, and shared-plans directory. A
project with no saved context returns `200` with empty arrays.

The following routes use the same project ID:

- `PUT /todos` with `{ "todos": [...] }`
- `POST /notes` with `{ "body": "...", "source": "manual|selection|agent" }`
- `PATCH /notes/:noteId` with `{ "body": "..." }` and/or `{ "pinned": true }`
- `DELETE /notes/:noteId`
- `POST /plans` with `{ "title": "...", "body": "..." }`
- `PATCH /plans/:planId` with `{ "pinned": true }`
- `GET` and `PUT /plans/:planId` (`PUT` accepts `{ "raw": "..." }`)
- `DELETE /plans/:planId`
- `POST /plans/:planId/share` and `/unshare`

Context metadata is stored under
`$OPENCHAMBER_DATA_DIR/projects/:projectId/context.json`, with plan markdown in
the adjacent `plans/` directory. If `OPENCHAMBER_DATA_DIR` is unset, the
default is `~/.config/openchamber`. Writes use per-project serialization and
atomic replacement. The first read migrates legacy context keys from the
sibling `:projectId.json` file.

## Linear compatibility

### `GET /api/linear/auth/status`

Returns `{ "connected": false }` with `200 OK`. The sidecar does not store
Linear credentials or implement Linear OAuth. This response lets OpenChamber
treat Linear as disconnected instead of logging a missing route.

Linear authorization, issue, mapping, and session-status routes are not
implemented by the sidecar.

## OpenChamber compatibility snapshots

### `GET /api/guests`

Returns the OpenChamber guest-extension catalog. The sidecar does not manage
OpenChamber guest packages, so it returns an explicit empty catalog:

```json
{ "guests": [] }
```

### `GET /api/sessions/status`

Returns the cross-project status snapshot used by OpenChamber's global status
seed. Unlike `GET /session/status`, which returns the native OpenCode status
map, this route wraps each active status with a server timestamp and includes
pending permissions/questions:

```json
{
  "sessions": {
    "ses_123": {
      "status": "busy",
      "lastUpdateAt": 1756001000000
    }
  },
  "pending": {},
  "serverTime": 1756001000000
}
```

## Git

Git routes use the local `git` executable and accept the repository directory
through the `directory` query parameter. The sidecar supports the read and
write operations used by OpenChamber's Git view, including repository status,
branches, diffs, commits, remotes, pull/push/fetch, stashes, merge/rebase
conflict handling, identities, and worktrees.

### Repository state

`GET /api/git/check` returns `{ "isGitRepository": boolean }`.

`GET /api/git/status` returns the current branch, upstream, ahead/behind
counts, changed files, diff statistics, and in-progress merge or rebase
metadata. `GET /api/git/primary-root` and `GET /api/git/toplevel` return
`{ "root": "/path/to/repository" }`; the former resolves a linked worktree to
the primary repository.

`GET /api/git/branches` returns:

```json
{
  "all": ["main", "feature", "remotes/origin/main"],
  "current": "feature",
  "branches": {
    "feature": {
      "current": true,
      "name": "feature",
      "commit": "0123456789abcdef",
      "label": "feature",
      "tracking": "origin/feature",
      "ahead": 1,
      "behind": 0
    }
  },
  "defaultBranches": { "origin": "main" }
}
```

### Files, history, and worktrees

The following endpoints are available with the same request shapes as the
OpenChamber Git client:

- `GET /api/git/diff`, `/range-diff`, `/range-files`, `/file-diff`
- `GET /api/git/log`, `/commit-files`, `/commit-file-diff`
- `POST /api/git/stage`, `/unstage`, `/revert`, `/apply-hunk`, `/commit`
- `GET /api/git/worktrees`
- `POST /api/git/worktrees`, `/worktrees/validate`, `/worktrees/preview`,
  `/validate-directory`, `/canonicalize-worktree-state`
- `GET /api/git/worktrees/bootstrap-status` and `GET /api/git/worktree-type`
- `DELETE /api/git/worktrees`

Worktree creation returns `{ head, name, branch, path, bootstrapStatus }` and
places managed worktrees under
`$XDG_DATA_HOME/opencode/worktree/<project-id>` (or
`~/.local/share/opencode/worktree/<project-id>` by default). Worktree removal
refuses to remove the primary repository.

### Remotes, history mutations, and identities

`POST /api/git/pull`, `/push`, `/fetch`, `/rebase`, `/merge`,
`/rebase/continue`, and `/merge/continue` run the corresponding local Git
operation. Abort routes, checkout, cherry-pick, revert, reset, branch
creation/deletion/rename, remote management, stash operations, and
`GET /api/git/conflict-details` are also supported.

Git identity profiles are stored in the user's OpenChamber configuration:

- `GET/POST /api/git/identities`
- `PUT/DELETE /api/git/identities/:id`
- `GET /api/git/global-identity`, `/current-identity`,
  `/has-local-identity`, `/discover-credentials`
- `POST /api/git/set-identity`

Credentials are never returned; discovery reports only credential host and
username.

---

## Sessions

### `GET /session` · `GET /experimental/session`
Lists sessions available in the specified directory or across all roots.

- **Query Parameters**:
  - `directory` (string, optional): Filter by workspace directory.
  - `roots` (boolean, optional): Return all sessions across all workspaces.
- **Response `200 OK`**:
```json
[
  {
    "id": "ses_019f65f9fa217000892db00212c6d038",
    "title": "Build authentication flow",
    "directory": "/path/to/project",
    "path": {
      "root": "/path/to/project",
      "cwd": "/path/to/project"
    },
    "cost": 0,
    "tokens": {
      "input": 0,
      "output": 0,
      "reasoning": 0,
      "cache": { "read": 0, "write": 0 }
    },
    "time": {
      "created": 1756000000000,
      "updated": 1756001000000
    }
  }
]
```

### `POST /session`
Creates a new session in the specified directory.

- **Request Body**:
```json
{
  "directory": "/path/to/project",
  "title": "Optional session title"
}
```
- **Response `201 Created`**: Returns the newly created `Session` object.

OpenChamber mints `ses_` ids client-side (`ses_` + nanoid) and rejects a
session that comes back under a different id, so a requested id is echoed
verbatim: it is stored as `openCodeId` in the transcript header while the OMP
UUID stays the file name. Canonical `ses_<32hex>` ids keep decoding to the OMP
UUID as before.

### `GET /session/:id`
Retrieves metadata for a specific session.

- **Response `200 OK`**: Returns the `Session` object.
- **Response `404 Not Found`**: If session does not exist.

### `PATCH /session/:id`
Updates a session. All fields are optional; `title` goes to omp (`set_session_name`).

- **Request Body**:
```json
{
  "title": "New Session Title",
  "metadata": { "openchamber": {} },
  "archived": true
}
```
`archived: true` hides the session from the default list (`?archived=true` lists it) and stamps `time.archived`;
`archived: false` restores it. The state lives in the session's doc, not the transcript.
- **Response `204 No Content`**.

### `DELETE /session/:id`
Deletes the session: its runtime, its transcript JSONL file, its artifact directory (subagent transcripts, tool logs) and its doc. `204` (`404` when it does not exist).

### `GET /session/status`
Returns the sessions that are busy now, keyed by session id; idle sessions are
absent. The map is computed when asked (`docs/architecture.md`, "The busy
model"), not stored:

- a session with a live runtime is busy while a parent run is live or due
  (including the gap before an omp-scheduled goal continuation);
- a running subagent's child session is busy while its parent's runtime says so;
- any other session is busy only when a running omp holds its lease **and** the
  transcript tail is mid-turn. No lease holder means idle regardless of the tail.

The parent session is idle while only background subagents or async jobs run;
those appear as busy child sessions and in `GET /experimental/job`.

- **Query Parameters**: `directory` (string, optional): restrict to one project.
- **Response `200 OK`**:
```json
{
  "ses_019f65f9fa217000892db00212c6d038": {
    "type": "busy"
  }
}
```

### `GET /session/active`
Returns the OpenCode v2 global active-session snapshot. Each entry has
`{ "type": "running" }`; idle sessions are omitted. The OpenCode SDK unwraps
`data`, so the map is enveloped.

**Response `200 OK`**:
```json
{
  "data": {
    "ses_019f65f9fa217000892db00212c6d038": { "type": "running" }
  }
}
```

**Response `503`**: a session's status could not be determined (the lease probe
failed). OpenChamber treats an empty map as "all idle" and starts queued sends
and goal turns, so an unknown status is an error here, never an empty map.

### `GET /experimental/job`
Background work running in driven sessions: subagents and async jobs, from
omp's `get_subagents` / `get_state`.

---

## Messages & Prompts

### `GET /session/:id/message`
Fetches all messages for a session via direct JSONL read (fast path).

- **Response `200 OK`**:
```json
[
  {
    "info": {
      "id": "msg_ses_123_0",
      "role": "user",
      "sessionID": "ses_019f65f9fa217000892db00212c6d038",
      "agent": "omp",
      "model": {
        "providerID": "llama.cpp",
        "modelID": "qwen3.8-27b",
        "variant": "default"
      },
      "time": {
        "created": 1756000000000,
        "completed": 1756000000000
      }
    },
    "parts": [
      {
        "id": "part_ses_123_0_0",
        "sessionID": "ses_019f65f9fa217000892db00212c6d038",
        "messageID": "msg_ses_123_0",
        "type": "text",
        "text": "Please summarize the codebase"
      }
    ]
  }
]
```

#### Tool names and cards
omp's tools reach OpenChamber under the names it keys its rendering on; live and history agree.

| omp | OpenChamber | Notes |
|---|---|---|
| `bash` | `shell` | A non-zero exit is an error whose message is only `Exit code N`; the command output stays the result (`content`), so it renders as output. Timeouts and aborts keep omp's text as the error. |
| `todo` | `todowrite` | The list comes from the call's result. |
| `write` to `agent://<id>[?progress]` | `irc` | A message to another agent. Input: `ircTo`, `content` (the body), `description` (`→ <id>`). |
| received `irc:*` message, parent steer (`parentIrc`) | `irc` | Completed card, output = the sender's own words (never the `<irc>` envelope); `description` is `← <sender>`. Live from `irc_message` frames and the steer's `message_start`; in history from `irc:*` `custom_message` entries and `parentIrc` user messages. |
| omp's developer messages | `developer` | |

A subagent's session is titled with its omp id (`OhMyPiExtension`), live and listed.

### `POST /session/:id/prompt_async` · `POST /session/:id/prompt` · `POST /session/:id/message`
One prompt; the three routes differ only in the acknowledgement. The sidecar
starts a runtime for the session when none is live, applies the model pick
(`model` in the body, else the session's recorded model: `set_model` plus
`set_thinking_level`, so the picked effort is what runs), and hands the message
to omp. A staged revert is committed first. A prompt is refused with `400` when
another omp owns the session (omp would otherwise fork it); send from a fork or
close that omp.

- **Request Body**:
```json
{
  "id": "msg_client_minted",
  "parts": [
    { "type": "text", "text": "Write a unit test for main.ts" }
  ],
  "model": { "providerID": "llama.cpp", "modelID": "qwen3.8-27b" },
  "variant": "high",
  "delivery": "steer",
  "credentials": {
    "apiKey": "...",
    "baseUrl": "https://api.example.com/v1"
  }
}
```

- `id` is OpenChamber's client message id. It is sent to omp as `hostMessageId`
  (P1) and is the message id in the transcript from then on.
- `delivery: "steer"` adds input to the run in progress (omp's steer);
  otherwise a prompt sent while a run is live is queued as omp's follow-up. Both
  join the current run, so there is no "session busy" refusal. Several
  busy → idle pairs can follow one prompt when omp starts further runs (queued
  input, goal continuation, background results).
- A prompt whose whole text is `.` is omp's continue (`resume`): no message
  reaches the model, an idle session runs omp's recovery directive, a streaming
  one is interrupted and continued. The transcript keeps a `.` message under the
  client id. On a subagent session `.` resumes that subagent.
- A prompt to a subagent session goes to its parent's runtime: `steer_subagent`
  while it runs, otherwise `409` (send `.` to resume it, or prompt the parent).
  It is announced like any prompt (`session.inbox.enqueued`), stays pending until the
  subagent reads it (`session.inbox.delivered`, matched by text: omp journals no client
  ids for a subagent), is listed by the subagent session's `GET /inbox` meanwhile, and is
  cancelled (`session.inbox.cancelled`) when the subagent ends or is stopped first.
- A body starting with `/aside <question>` is a side question (below).
- `credentials` / `credentialRef`: see "Caller-owned credentials".

- **Response, `prompt_async` and `message`**: `200` `{"queued": true}`.
- **Response, `prompt`**: `200` `{"data": { id, sessionID, type: "user", payload, delivery, time }}`.
- **Errors**: `400` invalid body or session owned by another omp, `404` unknown
  session, `409` subagent not steerable, `500`/`502` omp refused the prompt or
  the model switch.

### `POST /session/:id/command`
Runs a slash command by sending `/<name> <arguments>` as the prompt. Body:
`{ "command" | "name", "arguments" | "text", "id"?, "files"?, "delivery"? }`.
`204` when accepted, same errors as a prompt. omp's builtin and plugin commands
(`GET /command`) run in omp.

### `POST /session/:id/summarize` · `/compact`
Compacts through the session's own runtime (a fresh child would compact its own
empty session). `200` with a `compaction` message; `409` when omp refuses
(streaming, nothing to compact).

### `POST /session/:id/shell`
Runs `command` through the session's runtime when it has one, otherwise a plain
`bash` in the session directory. Emits `session.shell.started` / `ended`; `204`.

### `POST /session/:id/interrupt` · `POST /session/:id/abort`
Esc. `interrupt` answers `{ "interrupted": boolean, "withdrawn"?: { "steering": string[], "followUp": string[] } }`;
the legacy `abort` answers a bare boolean.

The sidecar sends omp's `abort_and_restore_queue`: the parent run and its
synchronous subagents stop. Queued steer/follow-up messages are not dropped: once
the run has stopped they are **sent again** to omp, oldest first, under the ids
the client already shows. The first starts the next run, the rest follow it, and a
queued steer becomes a follow-up (`session.inbox.delivery.changed`, `delivery:
"queue"`). `withdrawn` lists only what could not be sent again (omp refused it or
the child is gone); those inbox bubbles are cancelled
(`session.inbox.cancelled`). It waits until the run has
stopped, bounded by 5 s; past that the omp child is killed, idle is published
with `aborted: true`, and the next prompt starts a fresh child on the same
transcript. Background subagents keep running; stop one by sending the abort to
its own session (`cancel_subagent`). A session with no live runtime answers
`interrupted: false`.

### Revert, redo, fork, move, model, rename

- `POST /session/:id/revert/stage` `{ messageID }`: moves omp's leaf to the
  message's parent (`navigate_tree`) and journals a `host-revert` entry (P2) so
  the branch is durable. The abandoned branch stays in omp's file; the message
  list shows only the active branch. `DELETE /session/:id/revert` is redo: back to
  the abandoned leaf. `POST /session/:id/revert/commit` (and any prompt) accepts
  the staged revert (`409` when nothing is staged). Only a user message is a
  valid boundary (`400`); an unknown one is `404`. The sidecar truncates nothing.
- `POST /session/:id/fork` `{ before? }`: omp's `fork`; the new transcript is
  omp's and the OpenChamber metadata is copied to the new session id.
- `POST /session/:id/move` `{ directory }`: omp's `/move <dir>`. omp keeps the
  session id and moves the file; a refusal becomes `409`/`500` with omp's text.
- `POST /session/:id/model` `{ model: { providerID, id, variant? } }`: applied
  immediately (a runtime is started when none is live), pushing the model and
  the effort; omp journals both. `502` if omp rejects the model, `400` when
  another omp owns the session.
- `PATCH /session/:id` with `title`: omp's `set_session_name` on the runtime.

Revert, fork, move and rename on a session another omp owns are refused (`409`).

### Goals (`/goal`)
omp's goal mode, run by the sidecar like `/aside` (typed, or sent as the `goal`
command): `/goal <objective>` (or `/goal set <objective>`) creates omp's goal on
the session's runtime, started when none is live; `/goal pause`, `/goal resume`
(also re-arms an active goal omp stopped continuing) and `/goal drop` change it.
Refusals are OpenCode's `400 InvalidRequestError` with the reason in `message`
(no goal, one already set, usage, `/goal budget`: omp's RPC cannot change a
budget), which OpenChamber shows while keeping the text in the composer; a bare
`/goal` answers with the goal's state that way. A `/goal` as the first message
of a session is refused (a goal works from an existing conversation). An
accepted `/goal <objective>` is journalled as a `host-command` custom entry and
shows as the user's message. omp runs the continuations itself and the session
stays busy through them; the agent completes the goal with its `goal` tool.

`GET /api/omp/goal/:sessionId?directory=` →
`{ sessionId, live, goal: null | { status: "active"|"paused"|"complete"|"budget-limited"|"dropped", objective, tokensUsed, tokenBudget? } }`:
the live omp's goal when one drives the session (`live: true`), else the last
goal the transcript journalled (`mode_change` `goal`/`goal_paused`, `none`, and
the `goal-completed` record). The Oh-My-Pi extension reads it.

OpenChamber's own "Session goal" (`metadata.openchamber.goal` and its
idle-driven small-model loop) is not served: switch it off in OpenChamber
(Settings → Chat → Session goal). Should its loop run anyway, its progress check
on `/experimental/generate/text` is answered without a model (`needs_user`, so it
parks its goal as blocked).

### Side questions (`/aside`)
A prompt `/aside <question>` (typed, or sent as the `aside` command) runs omp's
`/btw` on the session's runtime, started when none is live. It works while a run
is in progress and **does not change the session's status**: it opens no run, so
no `session.status` event is emitted. The question appears as a user message
`/aside <question>` and the answer streams as an assistant message, finalised
by omp's terminal record; ids derive from omp's topic id, so a transcript reload
shows the same messages. omp checkpoints each turn to `<session>/btw-history/`,
which the sidecar reads after a reload or restart. `400` for an empty question,
`409` on a subagent session (ask in the parent) or while a previous question is
still running.

### Caller-owned credentials (opt-in)
A prompt, or `POST /config/providers`, can carry exactly one of `credentials`
(a provider section in omp's `models.yml` shape: `providerID`, `apiKey`,
`baseUrl`, `api`, `auth`, `authHeader`, `headers`, `compat`, `discovery`,
`remoteCompaction`, `modelOverrides`, `disableStrictTools`, Bedrock guardrail
fields, `transport`, optional `models`) or `credentialRef` (opaque to omp). With
neither, omp keeps its normal host-local credential resolution. `providerID` is
optional inside `credentials`; if present it must match the selected model's
provider.

`credentialRef` is resolved by the HTTP resolver at `OC_CREDENTIAL_RESOLVER_URL`
(optional bearer `OC_CREDENTIAL_RESOLVER_TOKEN`): it receives `{ credentialRef,
providerID, modelID, cwd, openCodeId }` and returns the credential object, or it
under `credentials` / `credential`. A session's credentialed child is reused for
the same reference; a new reference or a changed payload replaces an idle child
(`409` while it is busy). For such a child the sidecar creates a private
temporary `PI_CODING_AGENT_DIR` with a generated `models.yml`, removed when the
child exits (best effort on an abrupt kill). Raw credentials are never written
to session data or sent in prompt frames. Errors map to `CredentialInputError`
statuses (`400`, `401` unresolved ref, `424` no resolver configured, `502`
resolver failure).

---

## Model Providers & Configuration

### `GET /model`
Returns the configured model catalog as a flat array of OpenCode model objects.
Provider IDs are omp's own (no prefix).

### `GET /model/default`
Returns `{ "providerID": "...", "modelID": "..." }` for the active default
model, or `null` if no default model is available.

### `GET /config/providers`
Queries the OMP model catalog and formats it for OpenChamber.

- **Response `200 OK`**:
```json
{
  "providers": [
    {
      "id": "llama.cpp",
      "name": "llama.cpp",
      "models": {
        "qwen3.8-27b": {
          "id": "qwen3.8-27b",
          "providerID": "llama.cpp",
          "name": "Qwen 3.8 27B",
          "capabilities": { "temperature": true, "reasoning": true },
          "limit": { "context": 131072, "output": 32768 }
        }
      }
    }
  ],
  "default": {
    "providerID": "llama.cpp",
    "modelID": "qwen3.8-27b"
  }
}
```

### `POST /config/providers`
Queries the model catalog using caller-owned credentials. This is the opt-in
counterpart to the legacy `GET` route and is useful for a provider settings
screen.

- **Request Body**:
```json
{
  "model": {
    "providerID": "openai",
    "modelID": "gpt-5"
  },
  "credentialRef": "vault://team-a/openai"
}
```

Use either `credentialRef` or a `credentials` object, but not both. The
response has the same `OpenCodeProvidersResponse` shape as `GET
/config/providers`. A resolver failure is returned as a JSON error with an
appropriate `4xx`/`5xx` status.

### `GET /config` · `GET /global/config`
Returns current configuration objects.

---

## Real-Time Events (SSE)

### `GET /events` · `GET /global/event` · `GET /event`
Opens an SSE stream emitting real-time turn deltas and status updates.

- **Envelope Format**: Data-only frames with top-level `type` or nested `payload`:
```text
data: {"type":"server.connected","properties":{}}

data: {"payload":{"id":"evt_01","type":"session.status","properties":{"sessionID":"ses_123","status":{"type":"busy"}}}}

data: {"payload":{"id":"evt_02","type":"message.part.delta","properties":{"sessionID":"ses_123","messageID":"msg_123_1","partID":"part_123_1_0","delta":"Hello"}}}

data: {"payload":{"id":"evt_03","type":"session.status","properties":{"sessionID":"ses_123","status":{"type":"idle"}}}}
```

---

## Approvals & Stubs

| Endpoint | Method | Behavior |
|---|---|---|
| `/permission` | `GET` | Returns pending tool permission requests. |
| `/permission/request` | `GET` | OpenCode v2 alias for pending tool permission requests. |
| `/permission/:id/reply` | `POST` | Confirms or rejects tool permission requests. |
| `/question` | `GET` | Returns pending interactive user questions. |
| `/question/:id/reply` | `POST` | Submits answers to interactive questions. |
| `/form` | `GET` | Returns pending questions in OpenCode's typed form shape. |
| `/session/:id/form/:formId/reply` | `POST` | Submits a typed form answer for a pending sidecar question. |
| `/session/:id/form/:formId/cancel` | `POST` | Cancels a pending sidecar question exposed as a typed form. |
| `/agent` | `GET` | Returns available agent personas (`[]` default). |
| `/command` | `GET` | Returns available slash commands. |
| `/skill` | `GET` | Returns registered agent skills. |
| `/mcp` | `GET` | Returns MCP server status map (`{}`). |
| `/api/small-model` | `GET` | Reports resolved small model and callable providers allow-list for OpenChamber. |
| `/api/small-model/generate` | `POST` | Executes one-shot text generation with the resolved small model (for live turn progress summaries, commit messages, etc.). |

---

## OpenChamber Web Client Routes

These are the routes OpenChamber's browser client calls directly when it is
pointed at the sidecar, or that its web server proxies to it. They answer in
the shapes the client's schemas expect so it renders its unavailable state
instead of failing on a missing route.

| Endpoint | Method | Response |
|---|---|---|
| `/fs/directory-stats` | `POST` | `{ "results": [{ "path", "isDirectory", "reason"?, "realPath"? }] }` for a `{ "paths": [...] }` body. `reason` is `not-found`, `not-directory`, or `unavailable`; the client maps the first two to "missing". |
| `/session-todos/:id` | `GET` | `{ "revision", "state": "ready", "todos": [{ "content", "status" }] }`, read from omp's todo state in the transcript. |
| `/session/:id/inbox` | `GET` | `{ "data": [...] }` — the pending message-queue items, plus the prompts the session's omp holds but has not read yet (a steer waiting for a step boundary, a follow-up), in the prompt-payload shape the client seeds as pending user messages after a reload. |
| `/session/:id/inbox/:itemId` | `DELETE` | `204` — cancels a queued prompt. |
| `/session/:id/inbox/:itemId` | `PATCH` | `409` — delivery mode is chosen by the prompt request, not by a queued item. |
| `/session/:id/view` | `POST` | `204` — records `time.viewed` from the `idle` timestamp and emits `session.viewed`. |
| `/sessions/:id/view` | `POST` | `{ "success": true, "sessionId", "viewed": true }` — OpenChamber's own web-server ack. |
| `/api/git/projects` | `POST` | `{ "projects": [{ "directory", "isGitRepository" }] }` for a `{ "directories": [...] }` body; `400` when the array is missing. |
| `/api/source-control/binding` | `GET` | `{ "repository": { "supported", "repositoryId", "configRevision", "bare", "remotes" }, "revision": 0, "binding": null }` for a repository; `422` with `code: "UNSUPPORTED_SOURCE_CONTROL_REPOSITORY"`, `reason: "not-a-git-repository"` otherwise. The sidecar has no hosted-forge integration, so `binding` is always `null`. |
| `/api/openchamber/spaces/archives` | `GET` | `{ "archives": [] }` — Spaces is owned by OpenChamber's web server. |
| `/api/openchamber/received-pages/config` | `GET` | `{ "available": false, "bases": [] }` — Received-pages is owned by OpenChamber's web server. |
