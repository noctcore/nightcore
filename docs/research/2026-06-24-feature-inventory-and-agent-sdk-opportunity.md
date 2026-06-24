# Research: Nightcore Feature-Completeness Inventory + Claude Agent SDK Opportunity

**Date:** 2026-06-24
**Agent:** kirei (feature-inventory + Agent-SDK lens)
**Status:** complete
**Sibling agents:** kirei-arch (3-tier wiring / IPC protocol), kirei-refactor (dead code / parked seams / structural debt)

## Problem

Two-part research. (1) A DONE / PARTIAL / PARKED feature inventory of Nightcore. (2) Evaluate whether the Claude Agent SDK offers capabilities Nightcore should adopt — given the premise that Nightcore "shells out to the user's installed `claude` CLI from a Bun sidecar."

## Headline Finding (corrects the Part-2 premise)

**Nightcore is already built ON the Claude Agent SDK.** `@nightcore/engine` imports
`query` from `@anthropic-ai/claude-agent-sdk@0.3.185` and drives it in
streaming-input mode. Evidence:
- `packages/engine/src/sdk-adapter.ts:18` — `import { query } from '@anthropic-ai/claude-agent-sdk'`
- `packages/engine/src/session-runner.ts:230` — `this.query = query({ prompt: this.inputStream(), options })`
- `packages/engine/package.json` — `"@anthropic-ai/claude-agent-sdk": "^0.3.185"`

Nightcore is **NOT** parsing raw `claude` CLI stdout. The SDK *itself* spawns the
Claude Code CLI as its subprocess transport; the recent "resolve the on-disk
claude CLI" commits (`resolve-claude-binary.ts`) only feed the SDK's
`pathToClaudeCodeExecutable` so a `bun build --compile` binary can find the CLI
the SDK would otherwise self-resolve. So "CLI-shell-out vs SDK-in-sidecar" is a
**false dichotomy** — they are the same thing here, and Nightcore is already on
the SDK path. The real Part-2 question is therefore *"adopt MORE of the SDK
surface,"* not *"migrate to the SDK."*

Capabilities Nightcore ALREADY uses through the SDK (verified in source):
structured streaming (`translateMessage`), session resume (`Options.resume`,
session-runner.ts:214), `canUseTool` permission gating (PermissionLayer),
`permissionMode` + `allowDangerouslySkipPermissions`, `allowedTools`/
`disallowedTools`, subagent presets (`Options.agents` <- `nightcoreAgents`),
hooks (`HookBus`), `maxTurns`/`maxBudgetUsd` ceilings, `effort`, file
checkpointing (`enableFileCheckpointing` + `rewindFiles`), live model list
(`supportedModels`), context usage (`getContextUsage`), task/todo system
messages (`CLAUDE_CODE_ENABLE_TASKS` -> `task-updated` events).

---

## Part 1 — Feature Inventory (DONE / PARTIAL / PARKED)

### A. Capability table

| Capability | Status | Where / Evidence |
|---|---|---|
| 3-tier wiring (web -> Tauri -> Rust -> NDJSON -> Bun sidecar -> engine -> SDK), bidirectional events | **DONE** | Verified end-to-end in `docs/arch/2026-06-22-wiring-map.md`; sidecar `apps/sidecar/src/index.ts`, engine `session-manager.ts` |
| Kanban board UI (5 columns, status lifecycle, drag/move, per-column empty states) | **DONE** | `apps/web/src/components/board/*` (Board, Column, TaskCard, TaskStatusDot) |
| Task spine + JSONL store (Rust), create/edit/delete/move, blocked-id derivation | **DONE** | `store/task.rs`; 6 task commands in `lib.rs:93-98` |
| Project registry (multi-project, switch active, rename/remove, git-init, is-git-repo) | **DONE** | `store/project.rs`; `components/projects/*`, `new-project/*` |
| Settings (model/effort defaults, run-mode, max-concurrency, cleanup, notify, maxTurns/maxBudget, About) | **DONE** | `store/settings.rs`; `components/settings/*`; commit `bf6e875` "make Settings real" |
| Live session stream -> transcript (assistant deltas, tool-use, results) persisted per task | **DONE** | `store/transcript.rs`; `sidecar.rs` reader; web `session-stream.ts`, `TaskDetail` |
| Auto-loop coordinator (scan eligible -> lease slot -> worktree -> dispatch -> re-tick) | **DONE** | `m2/coordinator.rs` (937 LOC); commands `start/stop/resume_auto_loop` |
| Concurrency / slot manager (cap N, abort handle per run) | **DONE** | `m2/slots.rs` (276 LOC) |
| Per-task git worktree isolation (add/remove/list/prune + startup reconcile) | **DONE** | `m2/worktree.rs` (776 LOC); safety-invariant guarded |
| Dependency ordering (eligible only when all deps Done; fail-closed) | **DONE** | `m2/deps.rs` (208 LOC, pure + unit-tested) |
| Failure circuit-breaker (sliding window, pause loop, resume to clear) | **DONE** | `m2/breaker.rs` (179 LOC) |
| Crash recovery / reconciliation (re-queue stranded InProgress/Verifying on startup) | **DONE** | `lib.rs:85-89` -> `coordinator::reconcile_tasks/worktrees` |
| Interactive permission relay (engine parks -> `permission-required` -> web prompt -> `approve-permission`) | **DONE** | `permission-layer.ts`; `sidecar/permission.rs`; `PermissionPrompt` |
| Permission modes incl. plan + bypass (`allowDangerouslySkipPermissions` safety flag) | **DONE** | `session-runner.ts:189`; `PermissionModePicker` |
| Plan-approval gate (`ExitPlanMode` -> `waiting_approval`; approve/reject/refine) | **DONE** | `workflow/plan_approval.rs`; `ReviewPanel` |
| M4 verification gate (build -> commit -> independent reviewer -> done / auto-fix / park) | **DONE** | `sidecar/verification.rs` (548 LOC) |
| Pre-merge gauntlet (detect real tooling: bun/npm scripts or Cargo; stop at first fail) | **DONE** | `workflow/gauntlet.rs` (531 LOC); `GauntletResults` UI |
| Commit / merge of verified tasks (worktree commit; `git merge` no-force; conflict park) | **DONE** | `workflow/merge.rs` (285 LOC) |
| Per-kind presets (engine: prompt/tools/perm-mode; Rust: worktree/verify/writes-code policy) | **DONE** | `engine/kind-presets.ts` + `workflow/kind.rs`; `KindPicker`, `WorkModePicker` |
| Autonomy ceilings -> typed failure reasons (`max-turns`/`max-budget`) | **DONE** | `sdk-adapter.ts:358`; surfaced not silently passed |
| Usage/cost/duration surfacing (`session-completed` carries tokens/cost/durationMs) | **DONE** | `sdk-adapter.ts:336-341` |
| Live model list (dynamic `supportedModels()` probe, not hardcoded) | **DONE** | `session-manager.ts:132`; `ModelEffortPicker` |
| Sidecar packaging for distribution (`externalBin` + compiled binary + release-path resolve) | **DONE (newly closed)** | `tauri.conf.json:33`; `binaries/nightcore-sidecar-aarch64-apple-darwin` exists; `provider.rs release_sidecar_path()` — *the wiring-map's #1 packaging gap is now closed* |
| Claude-CLI-missing preflight (fail fast, actionable, per-platform install cmd) | **DONE** | `session-runner.ts:164`, `resolve-claude-binary.ts`; commits `acb8ab3`/`33c35fb` |
| TS<->Rust contract codegen (Rust->TS via ts-rs; zod->Rust generated structs) | **PARTIAL** | `contracts/generated.rs`, `lib/generated/*` exist (commits `888b350`/`7ce0cf8`) BUT the **sidecar NDJSON boundary is still hand-mirrored** (`provider.rs` raw `json!`, `sidecar.rs` `.get("camelCase")`) — drift fails silently. (kirei-arch's lens; noted.) |
| Session resume wired but no resume UX | **PARTIAL** | `Options.resume` plumbed (`session-runner.ts:214`) + used on recovery path; no user-facing "resume/continue this task" control or history viewer |
| File checkpointing / rewind | **PARTIAL** | engine proxies exist (`rewindFiles`, `contextUsage`) but Rust command + web UI are deferred ("STRETCH ... contract C", session-runner.ts:269-291) |
| Context-window usage gauge | **PARTIAL** | engine `contextUsage()` proxy only; no event/contract/gauge |
| External MCP servers | **PARKED** | `@nightcore/mcp` registry is empty (`externalMcpServers = []`); transports explicitly deferred (`tool-registry.ts:39-40`) — wired-but-inert placeholder |
| In-process custom tools (`@nightcore/tools` SDK MCP server) | **PARKED** | `nightcoreTools` defined + tested, but M4.7 A2 **unwired** them from live sessions (native SDK tools only). `ToolRegistry` kept only for `riskOf` risk metadata (`session-runner.ts:178-182`) |
| Subagent presets (`@nightcore/skills` -> `Options.agents`) | **DONE (data) / shallow (UX)** | `nightcoreAgents` IS passed to the SDK (`session-runner.ts:358`); but only 2 presets, no UI to author/select them |
| `new:tool` codegen scaffolder | **PARTIAL** | `tools/codegen/new-tool.ts` exists; auto-register + test generation noted incomplete in `architecture.md` "next steps" |
| Legacy CLI / TUI surfaces (`apps/cli`, `apps/tui`) | **PARKED / RETIRED** | No live-path references (only `@tauri-apps/cli` matches); preserved at tag `v0-ts-harness`; README labels legacy |
| Auto-update system | **PARKED (research only)** | `docs/research/2026-06-21-auto-update-system.md`; no impl |
| Second provider (Codex) behind `AgentProvider` trait | **PARKED (seam ready)** | `m2/provider.rs` `Provider` trait + pending-launch FIFO; only the Bun sidecar implements it |

### B. Per-package / per-tier appendix

- `apps/web` — **DONE.** Full board, projects, settings; single-bridge IPC (`lib/bridge.ts`); folder-per-component; Storybook+Vitest tests; ts-rs generated types in `lib/generated/`.
- `apps/desktop` (Rust core) — **DONE, beyond README's stated M2.** Implements M1 (task spine) + M2 (autonomy/worktrees) + M3 (plan gate, merge) + M4 (verification, kind, gauntlet). 30 Tauri commands, all symmetric with the web bridge.
- `apps/sidecar` — **DONE.** Thin NDJSON adapter; framing/dispatch/permission-relay unit-tested with a stub manager.
- `@nightcore/engine` — **DONE (the hub).** SessionManager/SessionRunner/PermissionLayer/HookBus/ToolRegistry/sdk-adapter; the only SDK consumer.
- `@nightcore/contracts` — **DONE (spine).** zod schemas; 10 events, 6 commands, config, records.
- `@nightcore/config`, `@nightcore/storage`, `@nightcore/shared` — **DONE.** All have live consumers.
- `@nightcore/skills` — **DONE (wired)** as subagent presets via `Options.agents`.
- `@nightcore/tools` — **PARKED.** Built + tested, unwired from sessions (risk-metadata only).
- `@nightcore/mcp` — **PARKED.** Wired-but-inert (empty registry, transport deferred).
- `@nightcore/eslint-plugin` — **DONE (tooling).**
- `apps/cli`, `apps/tui` — **RETIRED.**

---

## Part 2 — Claude Agent SDK: Adopt / Skip

### Premise correction (decisive)

Nightcore already runs on `@anthropic-ai/claude-agent-sdk@0.3.185`. There is no
"switch from CLI-parsing to the SDK" migration to evaluate — that migration is
**already done**. Also note: the experimental **V2 session API**
(`unstable_v2_createSession` / `send` / `stream`) was **REMOVED in SDK 0.3.142**;
the canonical interface is `query()` + `AsyncIterable<SDKUserMessage>` streaming
input — exactly what Nightcore uses. So "adopt the V2 SDK" is a non-option.
(Cited: SDK V2-preview doc, marked "removed".)

Version posture: installed `0.3.185`, latest `0.3.187` (3 patch releases, no
breaking changes). A trivial bump.

### What the current SDK offers that Nightcore does NOT yet use — and whether it's worth adopting

| SDK capability (cited) | Maps onto | Adopt? | Rationale |
|---|---|---|---|
| `listSessions()` / `getSessionMessages()` / `getSessionInfo()` / `renameSession()` / `tagSession()` (sessions + TS-ref docs) | `@nightcore/storage` (today only id->UUID metadata) + a future resume/history UX | **ADOPT (P1)** | The SDK already persists every transcript as resumable JSONL keyed by `cwd`. These functions let Nightcore build a per-task history viewer / session picker for free instead of re-persisting transcripts. Low effort, real payoff. |
| `forkSession: true` (sessions doc) | The existing "refine" / "try alternative approach" flow (`plan_approval.rs` refine) | **ADOPT (P2)** | Fork = branch the conversation to explore an alternative without losing the original. Natural fit for a worktree studio; the worktree already isolates files, fork isolates the conversation. Modest effort. |
| `continue: true` (sessions doc) | Multi-turn follow-ups on a completed task from the board | **CONSIDER (P2)** | Per-cwd "continue most recent" — but Nightcore tracks explicit ids, so prefer explicit `resume` over `continue`. Marginal. |
| External MCP transports: `mcpServers` (stdio/SSE/HTTP) + runtime `setMcpServers`/`toggleMcpServer`/`mcpServerStatus`/`reconnectMcpServer` (TS-ref) | The PARKED `@nightcore/mcp` seam | **ADOPT WHEN NEEDED (P2)** | This is the concrete path to light up the parked `@nightcore/mcp`: map `ExternalMcpServer` -> `Options.mcpServers`. The wiring is a thin pass-through. Worth doing only when a real external-server need appears (the seam is correctly parked, not dead). |
| `outputFormat: { type:'json_schema', schema }` structured output (TS-ref) | The M4 reviewer verdict parsing in `sidecar/verification.rs` (today parses free text, fail-safe) | **ADOPT (P1, high-value)** | The verification gate currently parses a reviewer's prose verdict defensively. A JSON-schema-constrained result message would make the verdict machine-reliable and remove a fail-safe-but-fragile parse. Strong fit for an autonomous gate. |
| `AgentDefinition` rich fields: `background`, `maxTurns`, `effort`, `permissionMode`, per-agent `mcpServers`/`skills` (subagents doc) | `@nightcore/skills` presets (today only description/prompt/tools/model) | **ADOPT (P2)** | Richer subagent presets (e.g. a read-only reviewer with its own `permissionMode`/`maxTurns`). Cheap to extend `SkillDefinition`. |
| `agent_id` forwarded to `canUseTool` for background agents (0.3.186 changelog) | PermissionLayer | **ADOPT WITH BUMP (P2)** | If Nightcore ever uses `background` subagents, this is required so their permission prompts reach `canUseTool` instead of auto-denying. Comes with the version bump. |
| `setMaxThinkingTokens()`, `thinking` config, `SDKThinkingTokensMessage` (TS-ref) | A reasoning-budget meter | **SKIP for now** | Cosmetic; no autonomy value. |
| `SessionStore` adapter (cross-host resume), `spawnClaudeCodeProcess` (remote/VM) (TS-ref) | — | **SKIP** | Explicitly for serverless / multi-host. Nightcore is local-first single-user; irrelevant. |
| `startup()` -> `WarmQuery` pre-warming (TS-ref) | Sidecar cold-start latency | **CONSIDER (P3)** | Could shave first-token latency on the persistent sidecar. Minor. |
| `sandbox` settings (TS-ref / 0.3.187 `sandbox.credentials`) | Bypass-mode safety in an autonomous studio | **CONSIDER (P2)** | For `bypassPermissions` autonomous runs, the SDK's sandbox could harden the blast radius. Worth a spike given the autonomy posture. |

### Where the SDK is NOT the answer (keep Rust)

Nightcore's **macro-orchestration** (auto-loop, slot/concurrency, dependency
ordering, circuit-breaker, per-task worktrees, crash reconciliation) correctly
lives in the **Rust core**, NOT the SDK. The SDK's own subagent fan-out
(`Options.agents` + the `Agent` tool) is *intra-session* — one `query()`
delegating sub-tasks within one conversation/context. The subagents doc itself
says runs that "coordinate dozens to hundreds of agents" belong in an external
orchestrator/Workflow, which is exactly Nightcore's Rust layer. So: SDK
subagents = a tool the agent uses *inside* a task; Nightcore's orchestrator =
the layer that runs *many independent tasks*. They are complementary; do not
collapse Nightcore's orchestration into SDK subagents.

### Trade-off summary: current architecture vs alternatives

- **Current (SDK-in-Bun-sidecar, Rust orchestrates):** the right shape. Keep it.
  Quarantines the (TS-only) SDK in a swappable process; Rust owns performance-
  critical always-on orchestration. The wiring map confirms it is fully wired.
- **"Replace SDK with hand-rolled CLI stdout parsing":** a regression — would
  lose structured `SDKMessage` typing, `canUseTool`, resume, hooks, control
  requests. Not recommended.
- **"Adopt V2 SDK":** impossible — V2 was removed in 0.3.142.
- **Net recommendation:** stay on `query()`; **bump 0.3.185 -> 0.3.187**; adopt
  the SDK's *session-management functions* (P1), *structured `outputFormat`* for
  the verification gate (P1), and light up the *MCP transport* + *fork* seams
  (P2) when a concrete need lands.

## Files to Modify (advisory — for build/forge, not this pass)

- `packages/engine/src/sdk-adapter.ts` / `session-runner.ts` — add `outputFormat`
  (structured reviewer verdict); surface `listSessions`/`getSessionMessages`.
- `packages/storage/src/index.ts` — back the session-history UX with the SDK's
  on-disk session functions instead of re-persisting transcripts.
- `packages/engine/src/tool-registry.ts` + `@nightcore/mcp` — map
  `externalMcpServers` -> `Options.mcpServers` when lighting up the MCP seam.
- `packages/skills/src/index.ts` — extend `SkillDefinition` with the richer
  `AgentDefinition` fields (`permissionMode`, `maxTurns`, `effort`, `background`).
- `package.json` (engine) — bump `@anthropic-ai/claude-agent-sdk` to `^0.3.187`.

## Reference Files (do not modify)
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — SDK type source of truth.
- `docs/arch/2026-06-22-wiring-map.md` — kirei-arch's wiring map (authoritative for the 3-tier IPC).
- `docs/research/2026-06-21-nightcore-sdk-capabilities.md` — prior SDK-capability map (written for the OLD TUI era; still accurate on SDK feature mechanics, stale on the surface targets).

## Risks & Gotchas
- **Premise inversion:** anyone reading "Nightcore shells out to the CLI" may try to
  "add the SDK." It is already there. Frame all SDK work as *adopt-more-surface*.
- **`resume` is cwd-keyed:** sessions live under `~/.claude/projects/<encoded-cwd>/`.
  Nightcore's worktree-per-task gives each run a distinct cwd, so resume keys
  cleanly per worktree — BUT if a worktree is pruned/moved, its cwd-keyed session
  history is orphaned. Coordinate worktree cleanup with any resume UX.
- **Sidecar drift seam (kirei-arch's lens):** the NDJSON boundary is hand-mirrored
  in Rust; adding SDK fields (e.g. structured verdict) means hand-updating
  `provider.rs`/`sidecar.rs` too, with no compile-time guard.
- **MCP/tools are PARKED, not dead** (per project memory). Don't delete; light them
  up via the SDK transports when needed.

## How to Verify
1. `grep -n "claude-agent-sdk" packages/engine/src/sdk-adapter.ts` -> confirms the SDK is the engine's model client (line 18).
2. `npm view @anthropic-ai/claude-agent-sdk version` -> confirms latest is 0.3.187 (installed 0.3.185).
3. Read the SDK sessions doc — `listSessions`/`getSessionMessages`/`forkSession`/`resume` are the named, current API.
4. Read the SDK V2-preview doc — confirms V2 removed in 0.3.142 (no migration target).

## Cited Agent SDK doc URLs
- TS reference: https://code.claude.com/docs/en/agent-sdk/typescript
- Sessions (resume/continue/fork, listSessions/getSessionMessages): https://code.claude.com/docs/en/agent-sdk/sessions
- V2 preview (REMOVED in 0.3.142): https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview
- Subagents (orchestration boundary): https://code.claude.com/docs/en/agent-sdk/subagents
- Releases / changelog (0.3.185-0.3.187): https://github.com/anthropics/claude-agent-sdk-typescript/releases
- npm (version): https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk

## Open Questions
- Resume/history UX: is a per-task transcript viewer (backed by `getSessionMessages`) wanted now, or deferred? (Could not validate interactively — running as sub-agent.)
- Structured reviewer verdict (`outputFormat`): adopt for the M4 gate now, or keep the fail-safe prose parse?
- Is the eventual second provider (Codex) close enough to justify keeping `@nightcore/mcp`/`tools` parked vs investing in lighting them up?
