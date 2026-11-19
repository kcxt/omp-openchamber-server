# Testing and coverage

One layer: `bun test` (alias for `bun test --timeout 90000 test/e2e`). The old unit/contract suites, the mock omp and the Jarvis adapter were removed; every test now drives the real OpenChamber 2.x UI in headless Chromium -> `openchamber serve` -> sidecar -> `test/stub-omp/omp`, with a throwaway `$HOME`, `PI_CODING_AGENT_DIR` and `TMPDIR`. No network, no credentials.

The stub is the main fidelity limit: it was written from omp's docs and never diffed against a real omp. Script format (`when`, text/thinking/tool/sleep/hang/fail/crash steps) is documented at the top of the stub and in `test/e2e/stack.ts`.

| File | What it asserts |
|---|---|
| `sessions` | Terminal-written sessions are listed (API and sidebar) for a project under `$HOME`, outside `$HOME`, and via symlink; API-created sessions land in omp's bucket. |
| `chat` | Text, reasoning, bash tool card with command/output, todo panel, v2 transcript shape, reload parity, model switch reaching omp and the recorded turn. |
| `history` | 80-message paging, Export Markdown (live and after reload), active `/tree` branch only. |
| `edit` | Cancel mid-stream; "Revert to this message" edit (UI, file and omp context agree); Redo; Fork from here. |
| `takeover` | A session a terminal omp still owns is refused (toast + API 400, no fork); once it exits the same file continues; idle release lets the terminal resume in place; `/fork` lineage sessions are top-level. |
| `panels` | Git (branch, change), Changes, Files, Terminal (runs a command in the project), Project knowledge notes (survive reload), Context/Walkthrough/Browser open; Stats, Issues and PRs, Scheduled tasks, Archive, Integrations catalog, Settings open; the sidecar served every request those made. |
| `failures` | Model API error (shown, idle, next turn works, survives reload); omp child dying mid-turn (error shown, idle, fresh child); sidecar SIGTERM and SIGKILL (history kept, open tab keeps working, reload consistent); sidecar killed mid-turn (ends idle). |

## API coverage at a glance

| Surface | Level |
|---|---|
| Session list / get / create / delete / archive | e2e (delete and rename not asserted) |
| Message list + paging, export | e2e |
| Prompt (`prompt`, `prompt_async`, `message`), model pick | e2e (text, tools, model); steer/queue, images, files, goals not covered |
| Abort | e2e; `interrupt` route not covered |
| Revert stage / Redo / implicit commit before prompt | e2e; explicit `/revert/commit` not covered |
| Fork (`/session/:id/fork`) | e2e (from here) |
| Refusing to prompt a session another omp owns | e2e |
| SSE event stream translated to UI state | e2e implicitly (text, reasoning, tool, todo, status, usage, reconnect after restart); websocket events not covered |
| Todos, Stats (`/experimental/session/stats`) | e2e |
| Providers / models | e2e (catalog, pick); credentials / `credentialRef` not covered |
| Git, files, terminal websocket, project notes | e2e through the panels |
| Provider errors, child crash, sidecar restart | e2e |
| Subagents / children and their lifecycle events | not covered (stub emits no subagent frames) |
| Permissions and questions (approvals bridge, `question` extension) | not covered |
| Compaction, shell (`/session/:id/shell`), slash commands | not covered |
| Message queue / inbox, steering mid-turn | not covered |
| Goals, plans, session knowledge | not covered |
| Settings routes, omp settings panel | Settings dialog opens; routes not asserted |
| Image attachments / blobs | not covered |
| Auth / passkey / UI password | stub, not covered |
| Browser control broker | not covered (Browser panel only opens) |

## Where more attention is likely to pay off

1. **Stub fidelity.** Real omp may differ on lease/fork timing, `get_state.sessionFile`, `get_session_lease` (on Linux it probes an abstract socket; the stub uses pid files), `session_exit` records written when a child is SIGTERMed (idle release and revert kill children more often), and how it reacts to the sidecar's own marker lines (`revert_change`, `viewed`, `oc_alias`, ...) appended to files it owns. A real-omp smoke over fork/revert/ownership would settle this.
2. **Ownership probe cost.** Every first prompt of a session without a live child spawns a probe omp (`get_session_lease`). A terminal omp that has the session open but has not written yet holds no lease and cannot be detected.
3. **Steering, queued prompts, concurrent prompts, subagents, approvals** during a turn: no coverage at all now that the unit suites are gone.
4. **Compaction, shell, slash commands, images, goals.**
5. **The `alias` path** (omp moves the session after the sidecar's check): implemented, no longer exercised since ownership is refused up front.
6. **OpenChamber-owned failures** seen in panels and deliberately ignored: `/api/source-control/binding` (422, no GitHub binding) and `/api/git/worktrees/archives` (500) come from OpenChamber's own web server, not the sidecar.
7. Deleting and renaming sessions from the UI, large or compacted histories.
8. Known TypeScript errors in `bun run check` (about 16, unrelated to the tests) are untouched.
