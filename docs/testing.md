# Testing and coverage

Two layers. `bun run test` (`bun test --timeout 90000 test/e2e`) drives the real OpenChamber 2.x UI in headless Chromium -> `openchamber serve` -> sidecar -> `test/stub-omp/omp`, with a throwaway `$HOME`, `PI_CODING_AGENT_DIR` and `TMPDIR`. `bun test test/contract` runs omp commands directly against the stub and, with `CONTRACT_OMP=real`, against the pinned real omp build, so stub drift is caught (below). No network, no credentials in either layer; the old unit suites, the mock omp and the Jarvis adapter are gone.

The stub is kept honest by the contract suite: every behaviour it models (stretch frames, queues, abort, lease, tree, fork, compaction, subagents, journaling) is asserted identically against the real omp. What it still does not model is listed at the bottom of `docs/research/R7.md`. Script format (`when`, text/thinking/tool/sleep/hang/fail/crash steps, `tool:"bash"` with `args.async`, `tool:"task"` with `subagent:{steps}`) is documented at the top of the stub and in `test/e2e/stack.ts`.

| File | What it asserts |
|---|---|
| `sessions` | Terminal-written sessions are listed (API and sidebar) for a project under `$HOME`, outside `$HOME`, and via symlink; API-created sessions land in omp's bucket. |
| `chat` | Text, reasoning, bash tool card with command/output, todo panel, v2 transcript shape, reload parity, model switch reaching omp and the recorded turn. |
| `history` | 80-message paging, Export Markdown (live and after reload), active `/tree` branch only. |
| `edit` | Cancel mid-stream; "Revert to this message" edit (UI, file and omp context agree); Redo; Fork from here. |
| `takeover` | A session a terminal omp still owns is refused (toast + API 400, no fork); once it exits the same file continues; idle release lets the terminal resume in place; `/fork` lineage sessions are top-level. |
| `commands` | Plugin commands (`/pi-vcc`) are listed; `POST /session/:id/command` with only name/arguments reaches omp as `/name args`; reasoning streams as `session.reasoning.*` events and never as answer text. |
| `edit-diff` | omp's numbered `details.diff` becomes unified hunks in the tool part's `metadata` (single file, batch, replace-mode input fallback); an edit call reaches the transcript with a patch. |
| `follow` | A session a terminal omp owns is followed read-only: its appended messages arrive as events bracketed by busy/idle; nothing is written or forked. |
| `panels` | Git (branch, change), Changes, Files, Terminal (runs a command in the project), Project knowledge notes (survive reload), Context/Walkthrough/Browser open; Stats, Issues and PRs, Scheduled tasks, Archive, Integrations catalog, Settings open; the sidecar served every request those made. |
| `failures` | Model API error (shown, idle, next turn works, survives reload); omp child dying mid-turn (error shown, idle, fresh child); sidecar SIGTERM and SIGKILL (history kept, open tab keeps working, reload consistent); sidecar killed mid-turn (ends idle). |

## Contract suite (`test/contract/`)

```
bun test test/contract                         # stub (default)
CONTRACT_OMP=real bun test test/contract       # real omp, run from /hdd/brute/projects/oh-my-pi-local
```

`CONTRACT_OMP_DIR` overrides the omp checkout, `CONTRACT_TMP` the scratch root (default `/hdd/brute/tmp`). Every child, real or stub, runs under an allow-listed environment (`PATH`, throwaway `HOME`/`PI_CODING_AGENT_DIR`/`XDG_*`/`TMPDIR`, `PI_SKIP_VERSION_CHECK`, `PI_TEST_SESSION_OWNERS_DIR`, `OMP_STUB_*`; never `process.env`), with a `models.yml` that declares only provider `fake` (a scripted local OpenAI-compatible server, `apiKey: dummy`). At spawn the harness asserts `get_available_models` lists only `fake/*` and aborts otherwise; the run prints `[contract:<kind>] get_available_models -> fake/fast, fake/smart`.

| File | What it asserts (both binaries) |
|---|---|
| `stretch` | R1: frame order of a plain turn, tool turn, follow-up (prompt and `follow_up`), steer, `abort`, abort with queued input (stranded stretch), `abort_and_restore_queue`, `abort_and_prompt`, background-job wake (`sessionSettled:false`, one `session_settled`), local prompts. |
| `entries` | R2: `get_entries` with/without `since`, `unknown_since`, delivery-order of user entries (steer overtakes follow-up), append-only compaction, small-session refusal, transcript file/lease created by the first assistant message, `model_change`/`thinking_level_change` journaling, id-less lines. |
| `tree` | R3 `navigate_tree` revert/redo (memory-only leaf, file untouched, durable after the next append); R4 `fork`/`branch`/`new_session` output (path, header, lineage, ids); R5 `/move`. |
| `lease` | R6 `get_session_lease` from a sessionless child: correctness, latency, crash release, the open-but-unwritten gap, fork lease. |
| `consumed` | R7 every frame/response field the sidecar reads, by type. |
| `subagents` | Subagent lifecycle/progress/event frames, wake ordering, `get_subagents`, `steer_subagent`, `cancel_subagent`. |

Last run: stub 43/43, real 43/43.

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
| Subagents / children and their lifecycle events | contract suite (frames, wake, cancel) on stub and real; not covered end to end through the UI |
| Permissions and questions (approvals bridge, `question` extension) | not covered |
| Compaction, shell (`/session/:id/shell`), slash commands | compaction frames and refusal in the contract suite; shell, slash commands not covered end to end |
| Message queue / inbox, steering mid-turn | contract suite (queue, steer, follow-up, abort and restore) on stub and real; not covered through the UI |
| Goals, plans, session knowledge | not covered |
| Settings routes, omp settings panel | Settings dialog opens; routes not asserted |
| Image attachments / blobs | not covered |
| Auth / passkey / UI password | stub, not covered |
| Browser control broker | not covered (Browser panel only opens) |

## Where more attention is likely to pay off

1. **Stub fidelity.** Now diffed against the real omp by `test/contract` (`docs/research/R7.md` lists what differed and was fixed). Remaining differences: goal continuations, auto-compaction, retries, approval round trips and image prompts are modelled from source or not at all; `session_exit` records written when a child is SIGTERMed are not asserted.
2. **Ownership probe cost.** Every first prompt of a session without a live child spawns a probe omp (`get_session_lease`). A terminal omp that has the session open but has not written yet holds no lease and cannot be detected.
3. **Concurrent prompts, approvals** during a turn: steering/queued prompts are in the contract suite, not in the UI suite; approvals have no coverage.
4. **Compaction, shell, slash commands, images, goals.**
5. **The `alias` path** (omp moves the session after the sidecar's check): implemented, no longer exercised since ownership is refused up front.
6. **OpenChamber-owned failures** seen in panels and deliberately ignored: `/api/source-control/binding` (422, no GitHub binding) and `/api/git/worktrees/archives` (500) come from OpenChamber's own web server, not the sidecar.
7. Deleting and renaming sessions from the UI, large or compacted histories.
8. Known TypeScript errors in `bun run check` (about 16, unrelated to the tests) are untouched.
