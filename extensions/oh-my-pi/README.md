<div align="center">

# Context

**Claude Code's `/context`, for the omp session open in OpenChamber.**

</div>

> [!NOTE]
> **Provenance.** Vendored from <https://github.com/MltStephane/openchamber-context> at commit
> `85d4e2be8a917f98142da4bbcf96a6e1239812e7` (package version 1.0.1). The upstream repository ships **no license
> file** and GitHub reports none, so it is all-rights-reserved by default: confirm terms with the author before
> publishing this repo. The panel UI (`status/`) is upstream's, adapted only where its data differs. The service and
> report builder are rewritten. Upstream's `docs/` screenshots show views that no longer exist here (largest items,
> loaded for nothing, subagents) and are kept only for the look.

A read-only breakdown of the context window of the open session: what fills it, how close compaction is, whether the
cache is probably still warm.

## What changed from upstream

Upstream reads Claude Code transcripts and OpenCode's SQLite database. Here, the service reads one sidecar route,
`GET /api/omp/context/:sessionId?breakdown=1` (`src/adapters/openchamber/omp-context.ts`), and finds the sidecar through
`<data dir>/omp-sidecar/endpoint.json` (default `127.0.0.1:4096`), the same way `extensions/omp-settings` does.

| Tab shows | Source in the sidecar answer |
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

The extension is registered by `bin/register-extensions` (run by `install.sh` and `bin/openchamber-serve`). Approve its
local service once in **Settings → Extensions**, then open the **Context** tab. It refreshes when the session's busy
state changes.

## Development

```sh
bun run build   # status/main.js (browser) + service/main.js (Node), via openchamber-guest-bundle
bun run check   # openchamber-guest-check
```

The built files are committed; OpenChamber compiles nothing.

```
package.json         manifest (id omp-context)
status/index.html    page loaded in the iframe
status/main.ts       host events, loading, stale answers dropped
status/view.ts       rendering and styles
status/i18n.ts       EN / FR dictionaries
service/main.ts      local HTTP service: POST /context -> sidecar
service/breakdown.ts sidecar answer -> report
```
