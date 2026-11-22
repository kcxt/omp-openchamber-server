# Repo rules

## Providers: never burn live quota

NEVER use omp's live provider endpoints while developing or testing this sidecar. In particular
`anthropic/*`, the local `llama.cpp` server, and `olla/*` are off-limits for any test, probe,
smoke run, or throwaway script.

- Default verification stays offline: `bun test` (headless OpenChamber UI -> sidecar -> `test/stub-omp/omp`)
  and `OC_FAKE_BACKEND=1` with `src/providers/fake/backend.ts`.
- Note `.omp/config.yml` in this repo points `modelRoles` at `anthropic/*`: any real `omp` child started
  from this checkout will spend anthropic quota. Set `PI_CODING_AGENT_DIR` to a throwaway dir (as the
  e2e harness does) before running a real binary.
- If a live model call is genuinely required, use a free endpoint only — e.g. an `nvidia/*` model —
  and keep it to the smallest possible number of requests.
