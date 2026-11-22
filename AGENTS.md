# Repo rules

## Providers: never burn live quota

NEVER use omp's live provider endpoints while developing or testing this sidecar. In particular
`anthropic/*`, the local `llama.cpp` server, and `olla/*` are off-limits for any test, probe,
smoke run, or throwaway script.

- Default verification stays offline: `bun test --timeout 90000 test/e2e` (headless OpenChamber UI ->
  sidecar -> `test/stub-omp/omp`) and `bun test test/contract` (stub; `CONTRACT_OMP=real` runs the
  patched omp in /hdd/brute/projects/oh-my-pi-local under an isolated env with a fake provider).
- Note `.omp/config.yml` in this repo points `modelRoles` at `anthropic/*`: any real `omp` child started
  from this checkout will spend anthropic quota. Run real binaries only through the contract harness, or
  with an `env -i` allow-list and throwaway `HOME`/`PI_CODING_AGENT_DIR`/`XDG_*` dirs.
- If a live model call is genuinely required, use a free endpoint only — e.g. an `nvidia/*` model —
  and keep it to the smallest possible number of requests.

## Editing files

ALWAYS use the read tool and the edit tool to read and change files. NEVER use sed, perl, python or
other inline find/replace unless genuinely necessary.
