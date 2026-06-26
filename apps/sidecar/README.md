# @nightcore/sidecar

The Bun NDJSON bridge — the sidecar tier of the Nightcore desktop studio.
A deliberately thin adapter: validates each inbound line against
`SurfaceCommandSchema`, forwards it to `@nightcore/engine`'s `SessionManager`,
and streams `NightcoreEvent` lines back on stdout. Zero orchestration logic
lives here. One persistent sidecar process multiplexes N concurrent sessions.

Bundled as a compiled `externalBin` in release builds; run via `bun run` in dev.

See [`docs/architecture.md`](../../docs/architecture.md) for the full 3-tier
model.

## Run / build / test

```bash
echo '{"type":"start-session","prompt":"say hello"}' | bun run sidecar   # raw NDJSON over stdio
bun test apps/sidecar       # unit tests (NDJSON framing, dispatch, permission relay; no live SDK)
bun run --filter @nightcore/sidecar compile   # compile to a standalone binary (required for cargo build)
```
