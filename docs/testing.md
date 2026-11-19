# Testing and coverage

Three layers. Run them with `bun test` (unit + contract, `src/`), `bun run test:e2e` (browser, `test/e2e/`) and `bun run test:live` (real omp, opt-in, needs credentials; not run in CI or offline).

`bun test src` has 30 failures that exist on the pre-e2e baseline (mostly `sse.test.ts`, `contract.test.ts`, `integration.test.ts`, the fake-backend HTTP tests, and part of the approvals/orchestration suites). They are untriaged, so treat those areas as **not currently verified** by the unit layer.

## 1. Offline end-to-end (`test/e2e`)

Real OpenChamber 2.x UI in headless Chromium -> `openchamber serve` -> sidecar -> `test/stub-omp/omp` (scripted omp that speaks the RPC protocol and persists sessions like omp). Throwaway `$HOME`, `PI_CODING_AGENT_DIR`, `TMPDIR`; no network, no credentials. The stub is the main fidelity limit: it was written from omp's docs, never diffed against a real omp.

| File | What it asserts |
|---|---|
| `sessions.test.ts` | Terminal-written sessions are listed (API and sidebar) for a project under `$HOME`, outside `$HOME`, and reached via symlink; sessions created through the API land in omp's bucket. |
| `chat.test.ts` | Text, reasoning, a bash tool card with command/output, todo panel (statuses, counts), v2 transcript shape, reload parity, model switch reaching omp `set_model` and the recorded turn. |
| `history.test.ts` | Offset paging of `/session/:id/message` visits every message once (80 msgs); Export Markdown contains each message once, live and after reload; only the active `/tree` branch is shown. |
| `edit.test.ts` | Cancel mid-stream (idle, partial kept once, next prompt works, omp context correct); "Revert to this message" edit (OpenChamber, file, and omp context agree); Redo; Fork from here. |
| `takeover.test.ts` | A terminal omp holding the lease -> OpenChamber continues in a fork under the same id; idle release lets the terminal resume the same file; `/fork` lineage sessions are top-level. |

## 2. Unit and contract suites (`src/**/*.test.ts`, mock omp)

Route-level contract tests against `test/mock-omp.mjs`, plus focused suites for approvals/questions, browser control, git, image budget, project context, small-model/title generation, subagents, message mapping from JSONL (`messages.file.test.ts`), event normalisation, the RPC transport, the credential runtime, the Jarvis adapter, and the fake second backend. Some of these are in the failing set above.

## API coverage at a glance

| Surface | Level |
|---|---|
| Session list / get / create / delete | e2e (list, create, reload, delete not asserted) + unit |
| Session rename, archive, move, mark viewed, pin metadata | unit only |
| Message list + paging (`/session/:id/message`) | e2e |
| Prompt (`prompt`, `prompt_async`, `message`) incl. model pick, thinking | e2e (plain text, tools, model); steer/queue, images, files, goals: unit only |
| Abort / interrupt | e2e (abort); interrupt route unit only |
| Revert stage / clear (Redo) / implicit commit before prompt | e2e; explicit `/revert/commit` route unit only |
| Fork (`/session/:id/fork`, with `before`) | e2e (from here); fork-whole-session unit only |
| SSE event stream (`/event`, `/global/event`) translated to UI state | e2e implicitly (text, reasoning, tool, todo, status, usage); websocket events, reconnection and heartbeat-loss recovery not covered |
| Todos (`/session/:id/todo`) | e2e |
| Providers / models / thinking levels | e2e (catalog, pick); credentials and `credentialRef` flows unit only |
| Subagents / children (`/children`, subagent lifecycle events) | unit only (the stub emits no subagent frames) |
| Permissions and questions (approvals bridge, `question` extension) | unit only |
| Compaction (`summarize`/`compact`) | unit only; stub has a trivial `compact` |
| Shell (`/session/:id/shell`), commands (`/command`) | unit only |
| Git, file browsing/search, diff, raw files | unit only (git.test.ts); nothing in e2e |
| Terminal websocket | not covered |
| Message queue / inbox routes, steering mid-turn | unit only |
| Goals, notes/plans/project context, session knowledge | unit only |
| Settings routes, omp settings panel, config PATCH | unit only; some failing in baseline |
| Auth / passkey / UI password | stub, not covered |
| Jarvis internal adapter | unit + one smoke test in `e2e-openchamber.test.ts` |
| Browser control broker | unit only |
| Image attachments / blobs | unit only |
| omp RPC failures: provider error, process crash, rpc timeout | unit only (stub supports `{fail}` but no e2e asserts it) |

## Where more attention is likely to pay off

1. **The failing baseline in `src/`.** 30 tests, including the SSE envelope and contract suites, are red and nobody has looked.
2. **Stub fidelity.** Real omp may differ on lease/fork timing, what `get_state.sessionFile` returns, `session_exit` records written when a child is SIGTERMed (idle release and revert now kill children more often), and how it reacts to the sidecar's own marker lines (`revert_change`, `viewed`, `oc_alias`, ...) appended to files it owns. A real-omp smoke (`test:live`) over fork/revert would settle this.
3. **Steering, queued prompts and concurrent prompts** during a turn: only unit-tested with fake transports.
4. **Subagents and approvals in the UI**: no e2e, and the stub has no frames for them.
5. **Provider errors and a crashed child** as seen in the UI.
6. **Restart behaviour**: `stack.restartSidecar()` exists but no test uses it. After a restart the alias index is rebuilt only by a session list, so a prompt before any list could resolve the pre-fork file.
7. **Live partial text**: only the last open block of a turn is closed on omp's `text_end`; steered or interleaved parts are not exercised.
8. **Deleting, archiving and renaming** sessions from the UI, and large or compacted histories.

## Routes the UI asked for that we do not implement

Across the e2e runs only `GET /api/websearch/provider` fell through to 404 (logged once per route as "unimplemented route"). Panels that were never opened in e2e (git, terminal, files, settings pages, scheduled tasks, stats) were not probed, so their missing routes are unknown; the sidecar log line is the quickest way to find them.
