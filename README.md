# Nightcore

**An autonomous Claude dev studio — a desktop Kanban board that runs agents for you.**

Nightcore is a local-first desktop app that turns a Claude agent into an
autonomous development teammate. You describe work as cards on a board; Nightcore
plans, dispatches, and runs each one — in parallel, in isolated git worktrees,
with dependency ordering and a failure circuit-breaker — and streams every
agent's progress back to the UI.

It is a from-scratch, better-architected reimagining of
[AutoMaker](https://github.com/AutoMaker-Org/automaker): the same autonomous
orchestration value, rebuilt on hard process boundaries instead of one
monolithic daemon.

> Local-first, single-user, Claude-first. No server, no database, no accounts.
> State lives under `~/.nightcore/` and per-project `.nightcore/`.

> **Heads up — this is a pivot.** Nightcore began as a thin Claude CLI/TUI
> harness. That codebase is archived at the `v0-ts-harness` git tag. The current
> direction is the desktop studio described here; the old TypeScript surfaces
> (`apps/cli`, `apps/tui`) are legacy and no longer the product.

## Architecture

Three tiers with hard boundaries — orchestration is native Rust, the SDK is
quarantined in a process-isolated sidecar, and the UI is a thin client:

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

- **Rust core** (Tauri 2) owns everything performance-sensitive and always-on:
  the task/project registries, the autonomous loop, the concurrency/slot
  manager, per-task git worktrees, dependency ordering, and the event bus.
- **Bun sidecar** is the *only* place the [Claude Agent
  SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) lives (there
  is no Rust SDK). It is deliberately dumb: it forwards commands into the engine
  and streams events back. No orchestration logic lives there.
- **React board** (React 19 + Vite + Tailwind v4) is a thin client that speaks
  only Tauri commands and the `nc:event` stream.

The core ↔ sidecar protocol is line-delimited JSON (NDJSON) over the child's
stdio: one `SurfaceCommand` per line in, one `NightcoreEvent` per line out,
human logs on stderr. See
[`docs/arch/2026-06-21-nightcore-studio-architecture.md`](docs/arch/2026-06-21-nightcore-studio-architecture.md)
for the full design, and [`docs/architecture.md`](docs/architecture.md) for the
package layer model.

## Requirements

- **[Bun](https://bun.sh) ≥ 1.1** — runtime for the sidecar and the TS
  workspace. Node 22 also works for the libraries.
- **A Rust toolchain** — to build the Tauri core (`cargo`, stable Rust).
- **The Claude CLI, installed and logged in.** Nightcore does **not** bundle the
  Claude CLI — install it yourself with
  `curl -fsSL https://claude.ai/install.sh | bash`
  (see the [setup docs](https://code.claude.com/docs/en/setup)), then run `claude`
  once to log in. Nightcore does not handle credentials; the Agent SDK inherits
  your local Claude login from `~/.claude`.

`@tauri-apps/cli` ships as a workspace dev-dependency, so no global Tauri install
is needed.

## Setup

```bash
# 1. Install the Claude CLI and authenticate (one-time, your responsibility):
#    curl -fsSL https://claude.ai/install.sh | bash   # see https://code.claude.com/docs/en/setup
#    then run `claude` once to log in.

# 2. Install workspace dependencies:
bun install

# 3. Typecheck the workspace:
bun run typecheck
```

`ANTHROPIC_API_KEY` is honored as an optional fallback if present in your
environment, but the intended path is your local Claude CLI login. Nightcore
never passes an API key itself and never brokers or persists tokens.

## Usage

Run the full desktop studio (builds the web UI, opens the window, spawns the
sidecar on demand):

```bash
bun run desktop      # tauri dev
```

Or run pieces individually:

```bash
bun run web          # Vite dev server only (browser preview; sidecar disabled)

# Drive the sidecar protocol by hand (raw NDJSON):
echo '{"type":"start-session","prompt":"say hello"}' | bun run sidecar
```

The sidecar prints `nightcore-sidecar ready` on stderr, then emits one
`NightcoreEvent` per line on stdout for the session lifecycle, assistant deltas,
tool use, permission requests, and completion (with cost + usage).

## Workspace layout

```
apps/
  desktop/   Tauri 2 shell + src-tauri/ — the Rust orchestration core
  web/       React 19 + Vite + Tailwind v4 — the Kanban board UI
  sidecar/   Bun NDJSON server wrapping the Claude Agent SDK
  cli/ tui/  LEGACY TS surfaces from the v0 harness (preserved at tag v0-ts-harness)
packages/    the sidecar's "brain" — retained from the harness era
  contracts/ the spine — Zod schemas + types (the wire protocol + shared types)
  shared/    logger, Result<T,E>, monotonic ids, path helpers
  config/    layered config resolver (defaults → ~/.nightcore → ./.nightcore)
  storage/   local session-metadata store (JSONL; transcripts stay with the SDK)
  engine/    SessionManager, SessionRunner, ToolRegistry, PermissionLayer, HookBus
  tools/     in-process SDK MCP tools (echo, read_file)
  skills/    subagent presets (placeholder)
  mcp/       external MCP server configs (placeholder)
tools/codegen/ `bun run new:tool` scaffolder
docs/        architecture summary + design/research docs
```

See [`docs/architecture.md`](docs/architecture.md) for the layer model and
dependency rules.

## Scripts

| Command | What |
|---------|------|
| `bun run desktop` | run the Tauri desktop app (`tauri dev`) |
| `bun run web` | run the React board in a browser (Vite dev server) |
| `bun run web:build` | build the web UI |
| `bun run sidecar` | run the Bun provider sidecar (raw NDJSON over stdio) |
| `bun run typecheck` | `tsc -b` across the workspace |
| `bun test` | the TS/Bun tests (sidecar, engine, contracts, web, …) |
| `bun run test:rust` | Rust core unit tests (`cargo test` in `apps/desktop/src-tauri`) |
| `bun run test:all` | every tier: node → web → plugin → Rust |
| `bun run new:tool <name> "<desc>"` | scaffold a new tool |
| `bun run lint` | eslint (flat config) |

### Testing

The suites are fast and offline (no live Claude session, no token use, no cost):

- **Rust core** (`apps/desktop/src-tauri`): `bun run test:rust` (or `cargo test`
  there). Covers `TaskStatus` serde, `TaskStore` JSON round-trips on a temp dir,
  `TaskPatch` application, the sidecar serial-guard, and the M2 seams (`src/m2/`).
  Any `cargo build` needs the compiled sidecar binary (Tauri `externalBin`); build
  it first with `bun run --filter @nightcore/sidecar compile`. `bun run test:rust`
  and `bun run test:all` run this compile step for you, so they work on a fresh
  checkout where `binaries/` is still empty.
- **Sidecar** (`apps/sidecar`): `bun test apps/sidecar` — NDJSON framing, command
  dispatch, event-per-line serialization, and permission relay. The
  `SessionManager` is stubbed, so the suite never spawns a model. (The engine's
  `session-manager.test.ts` stubs the SDK's `query()` the same way.)
- **Web** (`apps/web`): `bun run test:web` — Vitest + Storybook component tests.

## Status & roadmap

Following the studio milestones (see the architecture doc):

- **M0 — walking skeleton** *(done)*. Tauri + React → spawn Bun sidecar → run one
  prompt in cwd → stream deltas to a panel. Proves core ↔ sidecar ↔ SDK ↔ local
  auth end-to-end.
- **M1 — task spine + board**. `Task` domain model + JSONL store (Rust), Kanban
  board UI with the status lifecycle, run a task via the sidecar.
- **M2 — autonomy + isolation** (the AutoMaker core). Auto-loop coordinator,
  concurrency/slot manager, per-task git **worktree** isolation, dependency
  ordering, failure circuit-breaker.
- **M3 — provider trait + quality gates**. Formalize `AgentProvider`, stub a
  second provider, plan-approval gate, event hooks/notifications.

Open threads: sidecar packaging for distribution (`bun build --compile` →
Tauri `externalBin`), long-lived vs per-prompt sidecar, and the worktree
subsystem (the highest-risk M2 port).

## License

MIT © Shirone. Not affiliated with Anthropic. "Powered by Claude" — Nightcore is
not "Claude Code" and does not redistribute Claude credentials.
