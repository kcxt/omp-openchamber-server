# Sidecar handover (systemd)

`systemctl --user restart omp-server.service` swaps the sidecar for a new release without ending any omp session. This is the supported way to run the sidecar (`README.md`, "Run"); `OC_CHILD_SUPERVISOR=systemd` turns it on and `omp-server.service` sets it. Without it omp children are plain child processes and die with the sidecar.

## What happens on a restart

| Piece | Mechanism |
|---|---|
| The port | `omp-server.socket` owns it. systemd keeps the listener; connections made during the restart wait in its backlog and the new process serves them. |
| Each omp session | its own instance of the template `omp-child@.service` (`omp-child@<session>-<n>`), started with `systemctl --user start`. What to run (cwd, environment, argv) is handed over as credentials, `LoadCredential=` files that the sidecar writes; `bin/omp-child` reads its private copy and removes the originals. Not in the sidecar's cgroup, so stopping the sidecar does not touch it. |
| omp's stdin/stdout | two named FIFOs, `<unit>.in` and `<unit>.out`, in `OC_SUPERVISOR_DIR`. The child's wrapper opens both **read-write**, so it is its own reader and writer: the sidecar going away is neither EOF on stdin nor EPIPE on stdout. Frames omp writes meanwhile wait in the FIFO (64 KiB, then omp's write blocks: backpressure, not loss). |
| Telling a new sidecar what is running | one ledger record per child, `<unit>.json` (session id, transcript, FIFOs, credential dir) next to the FIFOs. |
| omp ending | the wrapper writes `{"type":"rpc_process_closed","exitCode":N}` into `out` when omp exits, so a crash reaches whichever sidecar is attached, in order. A unit that vanishes without it (stopped from outside) is noticed by a 2 s check. |
| The sandbox | `omp-child@.service` is the agents' sandbox; the sidecar's own sandbox is in `omp-server.service`. `JoinsNamespaceOf=omp-server.service` on each child, and in `openchamber.service`, shares the sidecar's private `/tmp` (the mount namespaces themselves stay separate, one per unit). |

On SIGTERM the old sidecar stops accepting, lets requests in flight finish (up to 1.5 s), writes any half-read frame into each ledger record (`rest`), and exits **without stopping the children**. The new one reads the ledger and, for each child whose unit is running, attaches to the FIFOs, asks omp for its state (`get_state`, `get_subagents`) and re-creates the session runtime from the answer. Nothing about busy/idle, the model, the title or running subagents is carried over: it is read back from omp. A run still streaming keeps the session busy until omp's own `agent_end`. A ledger record whose unit is gone is dropped; a running `omp-child@*` unit with no record is stopped.

## What it does not keep

- **Open SSE and WebSocket streams** end with the old process. OpenChamber reconnects, and the reconnect is served by the new one.
- **Frames omp emitted while no sidecar was attached** are dropped (the next transcript read shows their result). A turn in flight shows as a new assistant message from the first frame after the handover.
- **Pending approvals and questions** (an extension UI request omp is waiting on) live in sidecar memory. omp stays blocked on the request until it is answered or the session is aborted.
- **The peer address**: the public socket is forwarded to `Bun.serve` over a private unix socket (`src/services/socket-activation.ts`: `Bun.serve` cannot adopt an inherited fd, `node:net` can), so `RouteContext.clientIp` is `"unknown"`.
- A child keeps running if the sidecar is stopped for good. The next sidecar adopts it and its idle timer then releases it as usual; `systemctl --user stop 'omp-child@*'` ends them by hand.

## Security

`omp-server.service` binds the user bus and the manager's private socket (`BindPaths=%t/bus %t/systemd/private`) so it can call `systemctl --user` (the latter does not fall back to the bus). Whoever reaches that bus can start a unit outside the sandbox, so the shared drop-in deliberately does not bind it: the sidecar can, the agents cannot.

## Testing it: the capsule

`test/systemd/capsule.ts` starts an isolated `systemd --user` for a test: its own user, mount and cgroup namespaces, its own runtime dir, HOME and session bus, and a unit path pinned to a throwaway directory, so nothing in it can reach the real user manager. `test/systemd/handover.test.ts` runs the real launcher (`bin/omp-server`) in it against the stub omp (no providers):

- restart mid-turn: same child unit and pid, the new sidecar logs the adoption, the session is still busy, the turn finishes, a new prompt reaches the same child (one `switch_session` in total), and a probe hitting `/health` the whole time sees no refused or failed request;
- a child that dies is reported as a crash, its unit and ledger record go, and the next prompt starts a fresh child.

```bash
bun test --timeout 150000 test/systemd
```

It needs unprivileged user namespaces and a delegated, writable cgroup (any login session). The capsule's units mirror the shipped ones (the shipped drop-in names host paths such as `/opt/rocm`), so the shipped files themselves are not exercised end to end by the test.
