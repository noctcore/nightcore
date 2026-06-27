# @nightcore/desktop — Agent Contract

Read this before editing. Hard guardrails enforced by `bun run lint`, `bun run test:all`, and `tools/lint-meta`. Severity is **error or off, never warn**.

## Orchestration & boundaries
- ALL orchestration lives in the desktop core (Rust/Tauri); the sidecar stays a dumb relay. Do not push decision logic into the sidecar.
- This surface reaches the model ONLY through the `@nightcore/engine` façade — never import `@anthropic-ai/claude-agent-sdk` directly (enforced by `no-restricted-imports`).
- `apps/web` talks to this core ONLY through `lib/bridge.ts` (the single Tauri seam). Keep components Tauri-import-free.

## Contracts & codegen — regenerate, never hand-edit
- `src-tauri/src/contracts/generated.rs` is generated from `@nightcore/contracts` zod via `bun run codegen:contracts`; the `codegen-drift` lint-meta rule fails CI on any non-codegen diff. Change the schema and regenerate.
- Persisted/wire structs are serde-additive: every new field is `Option` with a `None` default in its own additive block, the struct carries `#[serde(rename_all = "camelCase")]`, and the change ships a field-absent pinning test PLUS an exact-wire-string round-trip test over every variant.

## Degrade, don't throw
- At the session/runtime boundary, errors become `session-failed` events; `run()` never rejects and session ids are never reused.

## Rust lint & test
- Before pushing Rust changes, run `cargo fmt --check` and `cargo clippy -- -D warnings` in `src-tauri`. This is a convention, not a `bun run lint` gate: `lint`/`lint:meta` run in the Bun workspace job, which carries no Rust toolchain or Tauri system deps — folding `cargo clippy` there would break that job. Rust compiles in the separate `rust-checks` CI job (`test:rust`).
- The authoritative test gate is `bun run test:all` (it includes `test:rust`); plain `test` omits the Rust suite.
