# nightcore (Rust core)

The Rust/Tauri orchestration brain — the middle tier of the Nightcore desktop
studio. Owns the task registry, auto-loop coordinator, concurrency/slot manager,
per-task git worktrees, dependency ordering, failure circuit-breaker, the
verification gauntlet, and settings. Spawns and drives the Bun sidecar over
NDJSON stdio. Exposes ~120 `#[tauri::command]` functions and 10 `nc:*` event
channels to the React board.

See [`docs/architecture.md`](../../../docs/architecture.md) for the full 3-tier
model.

## Build / test

```bash
bun run desktop                                    # tauri dev (full app)
bun run test:rust                                  # cargo test (compiles sidecar first)
bun run --filter @nightcore/sidecar compile        # compile sidecar binary (required before cargo build)
cargo test                                         # run Rust tests directly (needs compiled sidecar in binaries/)
```

Contract types are generated — do not hand-edit `src/contracts/generated.rs`
(regenerate with `bun run codegen:contracts`) or `../../apps/web/src/lib/generated/`
(regenerate with `cargo test`).
