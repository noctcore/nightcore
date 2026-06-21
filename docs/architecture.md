# Nightcore — Architecture (foundation)

This document is a short, living summary. The authoritative design lives in two
research docs (in the sibling `shiranami` repo where the research was run):

- **Combined findings:** `docs/chain/2026-06-21-nightcore-cli-harness.md`
- **Detailed architecture:** `docs/arch/2026-06-21-nightcore-harness-architecture.md`

See [`diagrams.md`](./diagrams.md) for rendered Mermaid diagrams of the layered
architecture, the start-to-end runtime flow, the event/command spine, and the
permission decision flow.

## The one-sentence model

**The Claude Agent SDK is thick; Nightcore is thin.** The SDK spawns and drives
a bundled Claude Code CLI subprocess that already owns the agent loop, built-in
tools, subagents, MCP, hooks, permission modes, and JSONL session persistence.
Nightcore is a **process supervisor + presentation shell** over it — not a model
client.

## Layers (dependency points inward)

```
apps/{cli,tui}                 surfaces — render events, send commands
        │ (engine façade + contracts only; never the SDK)
        ▼
packages/engine                SessionManager, SessionRunner, ToolRegistry,
                               PermissionLayer, HookBus, sdk-adapter
        │
        ├── packages/tools     in-process SDK MCP tools  ┐
        ├── packages/skills    subagent presets          │ capability layer —
        ├── packages/mcp       external MCP configs       ┘ import contracts/shared only
        ▼
packages/{contracts,config,storage,shared}   foundation — no app-specific deps
```

### Dependency rules (enforced loosely by `eslint.config.mjs`; full enforcement deferred)

| Layer | May import | Must NOT import |
|-------|-----------|-----------------|
| `apps/*` | `contracts`, `engine` (façade), `config` | the SDK directly |
| `engine` | `contracts`, `config`, `storage`, `shared`, SDK, `tools`/`skills`/`mcp` | `apps/*` |
| `tools`/`skills`/`mcp` | `contracts`, `shared` (+ SDK `tool()` primitive in `tools`) | `engine` (inversion) |
| `config`/`storage` | `contracts`, `shared` | `engine`, `apps/*` |
| `contracts`/`shared` | (nothing app-specific) | everything else |

## The spine — `@nightcore/contracts`

Two symmetric discriminated unions define the engine↔surface boundary:

- `NightcoreEvent` (engine → surface): `session-started`, `session-ready`,
  `assistant-delta`, `tool-use-requested`, `tool-result`, `permission-required`,
  `session-completed`, `session-failed`, `session-status`.
- `SurfaceCommand` (surface → engine): `start-session`, `send-input`,
  `interrupt`, `set-model`, `set-permission-mode`, `approve-permission`.

Plus `ConfigSchema`, `SessionRecord`, `ToolDescriptor`, `PermissionPolicy`.

## The supervisor — `SessionManager` / `SessionRunner`

Ported from shiranami's `analysis-host.ts` / `analysis-worker.ts`:

- **Monotonic session ids that never reset** → a late event from a torn-down
  runner is dropped instead of mutating a live session.
- **Degrade, not throw** → a runner crash surfaces as a `session-failed` event;
  `run()` never rejects. `PermissionLayer.failAllPending()` settles parked
  approvals on teardown.
- **Lazy/per-session runners**, N concurrent, each owning one SDK `query()` loop
  in streaming-input mode (so `interrupt`/`setModel`/`setPermissionMode` work).

## Auth

Zero credential code. The SDK's bundled CLI resolves the user's local Claude
credentials (`~/.claude`). `ANTHROPIC_API_KEY` in the inherited env is honored as
a fallback automatically — Nightcore never passes an `apiKey`. Setup is the
user's responsibility (install Claude CLI, run its login). See README.

## Deferred spikes / next steps

- **SPIKE — worker isolation.** Runners are in-process (the SDK already spawns a
  subprocess; an extra `worker_thread` per session is likely redundant). Whether
  sessions need a real OS-level boundary for crash isolation is open. Marked
  `// SPIKE:` in `session-manager.ts`.
- **SPIKE — `bun build --compile`** bundling of the platform-specific Claude Code
  binary; `pathToClaudeCodeExecutable` is the escape hatch.
- **Build out the TUI** (OpenTUI/Ink + React; plan-vs-build; interactive
  approvals).
- **Flesh out `tools` / `skills` / `mcp`** and finish the `new:tool` codegen
  (auto-register + test).
