# Documentation

This directory contains technical specifications and reference documentation for **`omp-openchamber-server`** — the OpenCode HTTP/SSE sidecar bridging [OpenChamber](https://github.com/OpenChamber/OpenChamber) to [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`).

---

## Guides & References

| Document | Description |
|---|---|
| [`architecture.md`](./architecture.md) | **Server Architecture** — Layout, runtime/registry/status model, omp layer, persistence, omp patches, and core invariants. |
| [`api-reference.md`](./api-reference.md) | **API Reference** — Complete OpenCode HTTP and SSE endpoint reference with request/response schemas. |
| [`omp-protocol.md`](./omp-protocol.md) | **oh-my-pi RPC Protocol** — Stdio NDJSON protocol, commands, turn events, disk schema, and process lifecycle. |
| [`openchamber-contract.md`](./openchamber-contract.md) | **OpenChamber Client Contract** — SSE event stream contract, message/part data structures, and UI reducer requirements. |
| [`testing.md`](./testing.md) | **Testing and coverage** — The e2e and contract suites, what each file asserts, and the coverage table. |
