# Nightcore Studio — Architecture

**Date:** 2026-06-21
**Status:** M0 scaffolded (walking skeleton green)
**Pivot:** from a TS Bun CLI/TUI harness (archived at tag `v0-ts-harness`) to a
Rust + Tauri **autonomous Claude dev studio** — a from-scratch, better-architected
reimagining of [AutoMaker](https://github.com/AutoMaker-Org/automaker).

> Companion docs: AutoMaker port analysis →
> [`docs/research/2026-06-21-automaker-port-analysis.md`](../research/2026-06-21-automaker-port-analysis.md).

---

## Why this shape

AutoMaker's value is its server-side orchestration (autonomous Kanban loop, git
worktree isolation, concurrency, dependency ordering). Its weakness — by the
contributors' own account — is architecture that accreted under delivery
pressure: ~60 services in one Node daemon, six model providers entangled through
the core, no time to refactor. Nightcore keeps the value and fixes the structure
by splitting responsibilities across three tiers with hard boundaries:

```
┌──────────────────────────────────────────────────────────────┐
│  apps/web — React board (Tauri webview)                        │
│  Kanban UI. Talks ONLY Tauri commands + the `nc:event` stream. │
└───────────────▲───────────────────────────┬──────────────────┘
                │ invoke / events            │
┌───────────────┴───────────────────────────▼──────────────────┐
│  apps/desktop/src-tauri — RUST CORE (the orchestration brain)  │
│  task registry · auto-loop · concurrency/slots · worktrees ·   │
│  dependency resolver · project registry · event bus · IPC.     │
│  Provider-agnostic. Native, always-on, performance-critical.   │
└───────────────▲───────────────────────────┬──────────────────┘
                │ NDJSON over stdio          │ spawn + drive
┌───────────────┴───────────────────────────▼──────────────────┐
│  apps/sidecar — BUN PROVIDER SIDECAR (the only place an SDK    │
│  lives). Wraps the Claude Agent SDK; streams normalized        │
│  events. Swappable: a Codex sidecar later speaks the same      │
│  protocol behind the same Rust `AgentProvider` trait.          │
└───────────────────────────────────────────────────────────────┘
```

**Key principle:** the performance-sensitive, always-on orchestration is native
Rust; the unavoidable SDK dependency (there is **no Rust Claude Agent SDK**) is
quarantined in a process-isolated sidecar; the UI is a thin client. AutoMaker put
all three in one Node process — we don't.

## Decisions locked (2026-06-21)

| Decision | Choice | Rationale |
|---|---|---|
| UI stack | **Rust + Tauri 2.11 + React 19 + Vite + Tailwind v4** | Mirrors `rin-client`; native core, web-tech UI. |
| Where orchestration lives | **Rust core** | Performance + the architecture rigor that's the whole point of the rewrite. |
| Agent SDK runtime | **TypeScript/Bun sidecar** | No Rust SDK. Reuses the already-built TS engine (`packages/engine` etc.) wholesale; full SDK parity (interrupt, setModel, callback hooks) vs. the Python SDK's gaps. |
| Providers | **Keep a provider seam** (`AgentProvider` trait) | User wants Codex/others later. Cleaner than AutoMaker's in-proc classes — each provider is a separate sidecar process speaking one protocol. |
| Repo | **Same `nightcore` repo, fresh Rust tree** | TS state archived at tag `v0-ts-harness`; `packages/*` retained as the sidecar's brain. |
| Auth | Inherit local `~/.claude` creds | Subscription auth; users self-setup `claude login`. Cannot embed a token (ToS). |

## The sidecar protocol (core ↔ provider)

Line-delimited JSON over the child's stdio. This is literally the engine's
existing `SurfaceCommand` / `NightcoreEvent` zod schemas, lifted to a
language-neutral wire format (Rust mirrors them as serde types — hand-kept in
sync, the `rin-client` convention):

- **stdin** ← one `SurfaceCommand` per line (`start-session`, `send-input`,
  `approve-permission`, `interrupt`, `set-model`, `set-permission-mode`).
- **stdout** → one `NightcoreEvent` per line (lifecycle, assistant deltas, tool
  use, permission requests, completion w/ cost+usage).
- **stderr** → human logs only; never part of the protocol.

The sidecar is deliberately dumb: it forwards parsed commands into
`SessionManager` and streams events back. No orchestration logic lives there.

## Milestones

- **M0 — walking skeleton (DONE / scaffolded).** Tauri+React → spawn Bun sidecar
  → run one prompt in cwd → stream deltas to a panel. Proves core ↔ sidecar ↔
  SDK ↔ local auth end-to-end. (Sidecar verified live: NDJSON stream, real
  session, `$0.12`, exit 0.)
- **M1 — task spine + board.** `Task` domain model + JSONL store (Rust), Kanban
  board UI (create card → status lifecycle `backlog→ready→in_progress→
  waiting_approval→verified→completed`), run a task via the sidecar, capture
  summary/status. Serial, in cwd. One long-lived sidecar, multiplexed sessions.
- **M2 — autonomy + isolation (the AutoMaker core).** Auto-loop coordinator
  (scan eligible → dispatch), concurrency/slot manager, per-task **git worktree**
  isolation for real parallelism, dependency ordering, failure circuit-breaker.
- **M3 — provider trait + quality gates.** Formalize `AgentProvider`; stub a
  second provider; plan-approval gate; event hooks/notifications.

## Repo layout (current)

```
nightcore/
├── apps/
│   ├── desktop/        # NEW Tauri 2 shell + src-tauri/ (Rust core)
│   │   └── src-tauri/src/{main,lib,sidecar}.rs
│   ├── web/            # NEW React 19 + Vite + Tailwind board UI
│   └── sidecar/        # NEW Bun NDJSON server wrapping the engine
├── packages/           # RETAINED (the sidecar's brain)
│   ├── contracts/      #   zod spine → the sidecar protocol + shared types
│   ├── engine/         #   sdk-adapter, SessionManager, permission layer
│   ├── config/ storage/ tools/ skills/ mcp/ shared/
│   └── …
├── apps/cli, apps/tui  # RETIRED (TS surfaces; preserved in tag v0-ts-harness)
└── docs/{arch,research}/
```

## How to run (dev)

```bash
bun install
bun run desktop      # tauri dev: builds web, opens window, spawns sidecar on demand
# or pieces:
bun run web          # Vite dev server only (browser preview; sidecar disabled)
echo '{"type":"start-session","prompt":"hi"}' | bun run sidecar   # raw protocol
```

Requires: `bun`, Rust toolchain, and `claude login` (local `~/.claude` creds).
`@tauri-apps/cli` is a workspace dev-dep — no global install needed.

## Open threads for later

- **Sidecar packaging for distribution:** dev runs `bun run <ts>`; a shipped app
  needs `bun build --compile` → a binary bundled via Tauri `externalBin`. The
  bundled Claude CLI must be threaded via `pathToClaudeCodeExecutable`.
- **Long-lived vs per-prompt sidecar:** M0 spawns one per prompt; M1 switches to
  one persistent sidecar multiplexing sessions/tasks.
- **Worktree subsystem (M2)** is the highest-risk port — resist copying all of
  AutoMaker's ~10 git services.
