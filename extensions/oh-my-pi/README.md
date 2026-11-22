<div align="center">

# Oh-My-Pi

**The omp side of an OpenChamber session: context window, goal and tasks, in one sidebar panel.**

</div>

> [!NOTE]
> **Provenance.** The Context view is vendored from <https://github.com/MltStephane/openchamber-context> at commit
> `85d4e2be8a917f98142da4bbcf96a6e1239812e7` (package version 1.0.1). The upstream repository ships **no license
> file** and GitHub reports none, so it is all-rights-reserved by default: confirm terms with the author before
> publishing this repo. The Context UI (`status/view.ts`, `status/i18n.ts`) is upstream's, adapted only where its data
> differs. The service and report builder are rewritten; the Goal and Tasks views, tabs and service routes are new.
> Upstream's `docs/` screenshots show views that no longer exist here (largest items, loaded for nothing, subagents)
> and are kept only for the look.

This is the extension for omp things that do not map cleanly onto OpenChamber's own UI. Today it has three views, as
tabs; future omp-only views are an entry in `SECTIONS` (`status/main.ts`), a service route and a view file.

| Tab | Shows | Sidecar route |
|---|---|---|
| **Goal** | omp's goal for the session: status badge, objective, tokens used / budget (bar when a budget exists), and whether the status is live (read from the omp process driving the session) or from the transcript. Empty state lists `/goal <objective>`, `/goal pause`, `/goal resume`, `/goal drop`. | `GET /api/omp/goal/:sessionId?directory=` |
| **Tasks** | omp's todo list, drawn like the rows of the Tasks section of OpenChamber's work-status panel: open tasks first, cancelled hidden. | `GET /api/session-todos/:sessionId?directory=` |
| **Context** | How full the context window is, like Claude Code's `/context`: omp's categories, compaction threshold, cache warmth, history curve. Refreshes when the session's busy state changes. | `GET /api/omp/context/:sessionId?breakdown=1&directory=` |

Goal and Tasks change mid-turn and the extension SDK has no event for them, so the panel polls the open one every 2 s
while it is visible (and re-reads on a session or busy change); an unchanged answer is not repainted. The Tasks tab
shows `done/total` next to its name.

## What changed from upstream

Upstream reads Claude Code transcripts and OpenCode's SQLite database. Here, the service reads sidecar routes. It
finds the sidecar through the host's `opencode` role (`service.provides: ["opencode"]`): the service does not inherit
the host environment, and the role is read-only and reaches only OpenCode's listed reads (`/api/session/:id`, not the
sidecar's `/api/omp` routes), whichever server this OpenChamber is connected to. So it reads
`GET /api/session/:id` through `OPENCHAMBER_OPENCODE_URL`, takes the sidecar's own address from
`metadata.omp.sidecarUrl`, and calls the sidecar directly. With no such field the panel says the session is not served
by the omp sidecar. There is no `endpoint.json` lookup and no default-port fallback.

| Context tab shows | Source in the sidecar answer |
|---|---|
| Total used | `current.used`: the provider-reported prompt size (exact) |
| Window | `breakdown.contextWindow`, else `current.window` (the model list the sidecar has seen); without either the tab says so |
| Categories (system prompt, system tools, system context, instruction files, skills, messages) | `breakdown.categories`: omp's own `/context` totals (`omp session inspect`). Without them: `current.nonMessage`, `history[-1].toolSchema` split into system / system tools / messages |
| Compaction tick, reserve, "on the next call" pill | `breakdown.thresholdTokens`, `breakdown.autoCompactBufferTokens` (omp's real values; hidden when omp gave none) |
| Growth per call, history curve | `history[].used` (last 10 / 40 points) |
| Cache read, cache write, warm/cold pill | `cache.lastTurnRead/Write`; pill timed from the last point's `at`. omp does not record the provider's cache lifetime, so 5 min is assumed and worded "probably" |
| Compactions | `compactions.count`, `tokensBefore`, `tokensAfter` |
| Model chip | `breakdown.model` |

Dropped, because omp has no data for them: *Largest items*, *Loaded but unused* (needs per-item attribution and tool
calls; omp's `get_context_view` is not built, see `bugs.md` item 7), *Subagents*, *Last output*, the *Source* fact, and
the expandable per-category items. Also removed: the Claude Code / OpenCode readers (`claude-*`, `opencode`,
`prompt-parts`, `subagents`, `compaction`, `limits`).

## Use

The extension is registered by `bin/register-extensions` (run by `install.sh` and `bin/openchamber-serve`; it also drops
the entries of the extension's earlier names). Approve it once in **Settings → Extensions**: both its local service and
its OpenCode access (read-only, see above), then open the **Oh-My-Pi** panel. Manage the goal from the composer with
`/goal <objective>`, `/goal pause|resume|drop`.

## Development

```sh
bun run build   # status/main.js (browser) + service/main.js (Node), via openchamber-guest-bundle
bun run check   # openchamber-guest-check
```

The built files are committed; OpenChamber compiles nothing. `node_modules` is a dev-only symlink to
`../omp-settings/node_modules` (git-ignored); if `bunx` cannot resolve the SDK's bins, run
`bun node_modules/@openchamber/sdk/scripts/bundle-guest.ts <in> <out>` (`--node` for the service) and
`.../check-guest.ts` directly.

```
package.json         manifest (id oh-my-pi)
status/index.html    page loaded in the iframe
status/main.ts       SECTIONS list, tabs, host events, polling, stale answers dropped
status/view.ts       Context view, shared helpers and styles
status/goal.ts       Goal view
status/tasks.ts      Tasks view
status/icons.ts      inline icons
status/i18n.ts       EN / FR dictionaries
service/main.ts      local HTTP service: POST /context, /goal, /tasks -> sidecar
service/sidecar.ts   finds the sidecar through the host's opencode role
service/breakdown.ts context answer -> report
service/goal.ts      goal answer -> report
service/tasks.ts     todo answer -> report
```
