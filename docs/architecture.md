# Nightcore — Architecture (foundation)

This document is a short, living summary. The authoritative, file-level design
lives in the dated `docs/arch/` series — most recently the as-built integration
map:

- **As-built 3-tier integration map:** [`arch/2026-06-24-asbuilt-integration-map.md`](./arch/2026-06-24-asbuilt-integration-map.md)
  (the accurate end-to-end wiring + Mermaid diagrams).

See [`diagrams.md`](./diagrams.md) for rendered Mermaid diagrams of the 3-tier
architecture, the run-a-task runtime flow, the event/command spine, and the
codegen contract boundaries.

## The one-sentence model

**The Claude Agent SDK is thick; Nightcore is thin.** The SDK drives the user's
installed `claude` CLI, which already owns the agent loop, native tools,
subagents, MCP, hooks, permission modes, and session persistence. Nightcore is a
**local-first desktop studio** over it — a Rust/Tauri orchestration core that
multiplexes autonomous agent runs, behind a React board — not a model client.

## The three tiers (the live desktop runtime)

```
apps/web — React board (Tauri webview)
        │  every IPC funnels through lib/bridge.ts (invoke / listen('nc:*'))
        ▼
apps/desktop/src-tauri — RUST CORE (the orchestration brain)
        │  task registry, auto-loop coordinator, slots, worktrees, breaker,
        │  verification gate, settings; spawns the sidecar, serializes commands
        ▼  spawn + NDJSON over stdio (one SurfaceCommand / line ↔ one event / line)
apps/sidecar — Bun bridge (deliberately dumb: validates + forwards, no logic)
        │
        ▼
packages/engine — the hub: owns the SDK query() loop
        │  SessionManager → SessionRunner → sdk-adapter (the ONLY SDK import)
        ▼
@anthropic-ai/claude-agent-sdk → the user's installed `claude` CLI
```

- **Renderer** (`apps/web`) — the React board. All IPC funnels through
  `lib/bridge.ts`; it `import type`s the Rust-generated TS bindings under
  `lib/generated/`.
- **Core** (`apps/desktop/src-tauri`) — the Rust orchestration brain. It owns the
  task registry, the M2 auto-loop (`m2/coordinator.rs`: slots, dependency
  ordering, circuit breaker, worktrees), the verification gauntlet, and settings.
  It spawns the sidecar and serializes commands to it. 35 `#[tauri::command]` fns
  ↔ 35 invoked from the bridge; 5 `nc:*` event channels (`nc:task`, `nc:session`,
  `nc:project`, `nc:loop`, `nc:permission`), each one Rust emitter ↔ one bridge
  listener.
- **Bridge** (`apps/sidecar`) — a thin NDJSON stdio adapter over `SessionManager`.
  It validates each line against `SurfaceCommandSchema` and forwards; zero
  orchestration logic. One persistent sidecar multiplexes N sessions.
- **Engine** (`packages/engine`) — the hub. `SessionManager` → `SessionRunner`
  owns the SDK `query()` loop; only `sdk-adapter.ts` imports the SDK runtime.

The sidecar is **bundled** as a compiled `externalBin` in release and run via
`bun run` in dev (`m2/provider.rs`). The `claude` CLI itself is **not bundled** —
it is a required prereq the engine resolves on the user's machine (fail-fast with
an actionable error if missing).

## Tools & the permission model

The agent runs on the SDK's **native tools** (Read/Write/Edit/Bash/Grep/Glob) —
the Claude-Code mental model. Nightcore does **not** ship in-process MCP tools.
`ToolRegistry` is retained only as a **risk-classification lookup** (`riskOf`)
that feeds the CLI-like permission gate (a static native risk map → permission
tiers). `@nightcore/tools` and `@nightcore/mcp` no longer reach the SDK and are
**slated for removal** per the 2026-06-24 decision (rely on native SDK tools +
UI-configurable external MCP instead). The code still exists; `ToolRegistry`
itself is **retained** even after the packages go, because `riskOf` is still
needed for permission-tier classification.

External MCP servers are **UI-configurable**: enabled entries from Settings are
injected additively over the user's native config via the SDK's
`Options.mcpServers`. An empty list omits the key entirely (byte-identical to the
pre-feature options).

## The contract spine — `@nightcore/contracts` + bidirectional codegen

The boundary types are **generated both ways**, never hand-mirrored:

- **zod → Rust** (the sidecar command/event boundary): `tools/codegen/gen-rust-contracts.ts`
  emits `src-tauri/src/contracts/generated.rs` from the zod schemas
  (`SurfaceCommand` / `NightcoreEvent`). `provider.rs` constructs and serializes
  the generated `SurfaceCommand` enum. Guard: `bun run codegen:contracts --check`
  + a `cargo test` conformance suite.
- **Rust serde → web TS** (the Tauri struct boundary): `ts-rs` exports the Rust
  structs (`Task` / `Settings` / `Project` / …) into `apps/web/src/lib/generated/`.
  Guard: `cargo test` regenerates them; CI asserts no `git diff`
  (`.github/workflows/ci.yml`, the `rust-checks` job).

Do **not** hand-edit the generated files — regenerate them (`cargo test` for the
ts-rs side, `bun run codegen:contracts` for the Rust side).

The two symmetric discriminated unions at the sidecar boundary:

- `NightcoreEvent` (engine → surface): `session-started`, `session-ready`,
  `assistant-delta`, `tool-use-requested`, `tool-result`, `permission-required`,
  `session-completed`, `session-failed`, `session-status`.
- `SurfaceCommand` (surface → engine): `start-session`, `send-input`,
  `interrupt`, `set-model`, `set-permission-mode`, `approve-permission`.

## The supervisor — `SessionManager` / `SessionRunner`

- **Monotonic session ids that never reset** → a late event from a torn-down
  runner is dropped instead of mutating a live session.
- **Degrade, not throw** → a runner crash surfaces as a `session-failed` event;
  `run()` never rejects. `PermissionLayer.failAllPending()` settles parked
  approvals on teardown.
- **Lazy/per-session runners**, N concurrent, each owning one SDK `query()` loop
  in streaming-input mode (so `interrupt`/`setModel`/`setPermissionMode` work).
- The session **history / resume** UX reads the SDK's resolved session info and
  rehydrates a prior run; the **provider-config inspector** reads the SDK's
  runtime control methods (`mcpServerStatus` / `supportedCommands` /
  `supportedAgents` / `initializationResult`) on a transient probe to show the
  resolved, scope-aware config for a project.

## Auth

Zero credential code. The user's installed `claude` CLI resolves the local Claude
credentials (`~/.claude`); `ANTHROPIC_API_KEY` in the inherited env is honored as
a fallback. Nightcore never passes an `apiKey`. Install the Claude CLI and run its
login — see the README.

## Alternate surfaces (retired v0)

`apps/cli` and `apps/tui` import `@nightcore/engine` **directly** and touch
neither the sidecar nor the Rust core — they are parallel in-process surfaces
kept from the original v0 TS harness (tag `v0-ts-harness`), **not** part of the
desktop 3-tier path.
