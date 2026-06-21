# Claude Agent SDK Usage Audit — Nightcore

**Date:** 2026-06-21 · **Type:** READ-ONLY research · **Scope:** how `@nightcore/engine` uses `@anthropic-ai/claude-agent-sdk`.

## SDK version

- **`@anthropic-ai/claude-agent-sdk@0.3.185`** (`node_modules/@anthropic-ai/claude-agent-sdk/package.json`).
- Type surface lives in `sdk.d.ts` (260 KB) + `sdk-tools.d.ts`. Key anchors: `Options` (`sdk.d.ts:1234`), `Query` interface (`sdk.d.ts:2182`), `query()` (`sdk.d.ts:2437`), `HookEvent` 30-event union (`sdk.d.ts:773`), `SettingSource = 'user' | 'project' | 'local'` (`sdk.d.ts:6061`).

## Importer map

`packages/engine` is the **only** tier importing the SDK. Importers:

- `packages/engine/src/sdk-adapter.ts:7-16` — the single broad import boundary (`query`, `Options`, `Query`, `SDKMessage`, `SDKUserMessage`, `AgentDefinition`, `ModelInfo`, `PermissionMode`). Re-exported to the rest of engine.
- `packages/engine/src/permission-layer.ts:3` — `CanUseTool`, `PermissionResult`.
- `packages/engine/src/hook-bus.ts:1-4` — `HookCallbackMatcher`, `HookEvent`.
- `packages/engine/src/tool-registry.ts:1-4` — `createSdkMcpServer`, `McpSdkServerConfigWithInstance` (**dormant — not wired into live sessions**; see DELIBERATELY DROPPED).

All other tiers (`apps/`, Rust core, `packages/contracts|shared|storage|skills`) speak `NightcoreEvent` / `SurfaceCommand` and never touch the SDK.

---

## USED — wired and exercised

| Capability | Where | How |
|---|---|---|
| `query({ prompt, options })` streaming-input loop | `session-runner.ts:157-168` | Prompt is an `AsyncIterable<SDKUserMessage>` (`inputStream()`, `:293-303`) so control requests are available. Messages iterated and translated. |
| `Options.model` | `session-runner.ts:124` | Static per session from config/command. |
| `Options.permissionMode` | `session-runner.ts:125` | From command → kind preset → config precedence (`session-manager.ts:177-180`). |
| `Options.includePartialMessages` | `session-runner.ts:126` | Always on → `stream_event` deltas → `assistant-delta` `partial:true` (`sdk-adapter.ts:292-316`). |
| `Options.canUseTool` (`CanUseTool` callback) | `session-runner.ts:127` + `permission-layer.ts:66-89` | Full harness permission gate: deny-list, risk-based prompt, allow-list, parks interactive approvals. |
| `Options.hooks` (`PreToolUse`, `SessionStart`) | `session-runner.ts:134` + `hook-bus.ts:36-50` | Non-blocking observers (`{continue:true}`), re-emitted to local observers. |
| `Options.abortController` | `session-runner.ts:135`, `:82` | Aborted in `interrupt()` (`:181-186`). |
| `Options.effort` | `session-runner.ts:136` | Threaded when present (static at query construction — see PARTIALLY USED). |
| `Options.allowDangerouslySkipPermissions` | `session-runner.ts:140-142` | Set only when `permissionMode === 'bypassPermissions'` (M4.7 §A1). |
| `Options.appendSystemPrompt` | `session-runner.ts:145-147` | From `review` kind preset (`kind-presets.ts:48-55`). |
| `Options.allowedTools` / `disallowedTools` | `session-runner.ts:148-153` | `disallowedTools` = `WRITE_TOOLS` for `review` kind (`kind-presets.ts:17-23`). |
| `Options.cwd` | `session-runner.ts:240` | Per session. |
| `Options.executable: 'bun'` | `session-runner.ts:241` | Runtime pin. |
| `Options.stderr` | `session-runner.ts:242` | Routed to debug logger. |
| `Options.settingSources` | `session-runner.ts:252` | Config-driven (default loads `'user'`); kept deliberately (M4.7 §A2). |
| `Options.agents` (`AgentDefinition` map) | `session-runner.ts:253` + `agent-presets.ts:22-25` | Nightcore subagent presets from `@nightcore/skills`, survives strict isolation. |
| `Options.env` (full replace + `process.env` spread) | `session-runner.ts:260-263` | Sets `CLAUDE_CODE_ENABLE_TASKS` toggle. |
| `Options.agentProgressSummaries` | `session-runner.ts:264` | On when todo feature enabled → `task_progress.summary`. |
| `Options.skills: 'all'` | `session-runner.ts:268` | Only when `settingSources` non-empty. |
| `Options.pathToClaudeCodeExecutable` | `session-runner.ts:269` | Set only for compiled-distributable case. |
| `Query.interrupt()` | `session-runner.ts:183` | Plus abort; surface `interrupt` command. |
| `Query.setModel()` | `session-runner.ts:189` | Surface `set-model` command (`session-manager.ts:99-100`). |
| `Query.setPermissionMode()` | `session-runner.ts:193` | Surface `set-permission-mode` command (`session-manager.ts:102-103`). |
| `Query.supportedModels()` (+ transient probe) | `session-runner.ts:208-228`, `session-manager.ts:125-134` | Reuses a live query or spins an input-less transient query, then tears it down. Powers `/model`. |
| `ModelInfo` → `ModelDescriptor` | `session-manager.ts:21-29` | Maps `supportsEffort` / `supportedEffortLevels`. |
| `SDKMessage` translation | `sdk-adapter.ts:91-358` | `system/init`, `assistant` (text + tool_use), `stream_event`, `result` (with full `usage` cost/token breakdown `:332-337`), and task lifecycle subtypes. |
| `createSdkMcpServer` (definition exists) | `tool-registry.ts:45-56` | Present but NOT passed to a live session — see DELIBERATELY DROPPED. |

---

## PARTIALLY USED — referenced but incomplete

| Capability | Where | Gap |
|---|---|---|
| **`Options.effort`** | `session-runner.ts:46-49`, `:136` | Fixed at query construction; the SDK exposes no live `setEffort`, but the engine also exposes no `set-effort` surface command (unlike `set-model`). A surface's effort choice only applies to the *next* session. |
| **`Query.supportedModels()`** | `session-manager.ts:125` | Wired, but per the punchlist (§G) the web ships a **static** model list; the dynamic list is a deferred stretch. So the method exists and works, but the live surface doesn't consume it yet. |
| **`Query.setModel()` mid-session** | `session-runner.ts:188-190` | Implemented + command exists, but it's reactive-only; no automatic model escalation/de-escalation policy uses it. |
| **`Options.hooks`** | `hook-bus.ts:36-50` | Only `PreToolUse` + `SessionStart` wired, both **non-blocking observers** that always return `{continue:true}`. The hook decision channel (block/modify/inject context) and 28 other `HookEvent`s (`PostToolUse`, `Stop`, `PreCompact`, `SubagentStop`, `SessionEnd`, …) are unused. `HookBus.on()` has no subscribers in-repo. |
| **`Options.agents` / subagents** | `agent-presets.ts` | Definitions passed, but `Query.supportedAgents()` (`sdk.d.ts:2275`) is never called to verify/enumerate what the session actually loaded. |
| **`result.usage` cost/token data** | `sdk-adapter.ts:332-337` | Captured into `session-completed`; only `costUsd` is persisted on the record (`session-manager.ts:256`). Token totals flow as an event but aren't aggregated/budgeted. |

---

## UNWIRED but valuable (prioritized)

All confirmed present in `sdk.d.ts`. Effort: S = <½ day, M = ~1 day, L = multi-day.

| # | Capability | SDK ref | Nightcore use case | Effort | Files to change |
|---|---|---|---|---|---|
| 1 | **`Options.maxTurns`** | `sdk.d.ts:1587-1590` | Runaway-loop guard for autonomous tasks — bound an auto-loop task so a wedged agent can't burn turns forever. Result `error_max_turns` already maps to `'max-turns'` (`sdk-adapter.ts:350`). | S | `session-runner.ts` (Options), config contract, kind preset |
| 2 | **`Options.maxBudgetUsd`** | `sdk.d.ts:1591-1595` | Hard cost ceiling per task for an unattended studio; stops at `error_max_budget_usd`. Pairs with the cost already tracked at `session-manager.ts:256`. | S | `session-runner.ts`, config/Task contract, `sdk-adapter.ts` (new failure subtype map) |
| 3 | **`Query.getContextUsage()`** | `sdk.d.ts:2282-2288` | Live context-window gauge in the surface; trigger compaction / warn before a long build hits the wall. | S–M | `session-runner.ts` (proxy method), `session-manager.ts`, new `SurfaceCommand` + event |
| 4 | **`Query.mcpServerStatus()` + `setMcpServers()`/`reconnectMcpServer()`** | `sdk.d.ts:2281`, `:2400`, `:2370` | Surface external MCP server health (connected/failed/needs-auth) — `tool-registry.ts:59-67` already lists external MCP descriptors but nothing reports their live status. | M | `session-runner.ts`, `session-manager.ts`, `tool-registry.ts`, events |
| 5 | **Blocking hooks: `PreToolUse` deny + `PostToolUse`/`Stop`** | `sdk.d.ts:1433`, hook union `:773` | Policy enforcement at the hook layer (e.g. block `git push --force`, auto-run lint/test on `Stop`, capture every tool result for the transcript). Bus already exists (`hook-bus.ts`); just needs decision returns + more events + subscribers. | M | `hook-bus.ts`, `session-runner.ts`, consumers |
| 6 | **`Options.resume` + `resumeSessionAt` + `forkSession`** | `sdk.d.ts:1713`, `:1727`, `:1412` | Resume a crashed/closed task from its SDK session id (already stored: `sdkSessionId` on `SessionRecord`, `session-manager.ts:249`). `forkSession` = branch an exploration from a known-good point. Big leverage for a durable studio. | M–L | `session-runner.ts`, `session-manager.ts`, `SessionRunnerConfig`, start-session command |
| 7 | **`Options.enableFileCheckpointing` + `Query.rewindFiles()`** | `sdk.d.ts:1388-1396`, `:2344` | One-click "undo this task's file changes" without git — rewind worktree files to a prior user message. Complements the deferred View-changes diff (punchlist §G). | M | `session-runner.ts`, `session-manager.ts`, new command/event |
| 8 | **`Options.fallbackModel`** | `sdk.d.ts:1381-1387` | Auto-failover when the primary model is overloaded (`overloaded` already maps to `rate-limit`, `sdk-adapter.ts:41`). Cheap resilience. | S | `session-runner.ts`, config contract |
| 9 | **`Options.additionalDirectories`** | `sdk.d.ts:1240-1244` | Let a worktree session also read a shared parent dir (e.g. monorepo root / shared design tokens) without making it cwd. | S | `session-runner.ts`, `SessionRunnerConfig`, start-session command |
| 10 | **`Options.thinking` (adaptive/budget) + `Query.setMaxThinkingTokens()`** | `sdk.d.ts:1551-1563`, `:2229` | Per-kind thinking depth (e.g. `review`/`decompose` get deeper thinking; `build` adaptive). More precise than the single `effort` knob. | S–M | `session-runner.ts`, kind presets, config |
| 11 | **`Query.supportedCommands()` / `init.slash_commands`** | `sdk.d.ts:2263` | `session-ready` already carries `slashCommands` (`sdk-adapter.ts:158`) but nothing surfaces a `/`-command palette. Low-hanging UX. | S | `apps/web` (consume existing event) |
| 12 | **`Query.stopTask()` / `backgroundTasks()`** | `sdk.d.ts:2412`, `:2425` | Cancel/background a single runaway subagent or Bash command without killing the whole session — finer-grained than `interrupt()`. | M | `session-runner.ts`, `session-manager.ts`, command/event |
| 13 | **`Options.outputFormat` (json_schema)** | `sdk.d.ts:1626-1638`, `:1968` | Structured machine-readable output for the `review` kind (verdict object) and `decompose` kind (task list) instead of parsing a `VERDICT:` line (`kind-presets.ts:52`). | M | `session-runner.ts`, kind presets, `sdk-adapter.ts` |
| 14 | **`Options.planModeInstructions`** | `sdk.d.ts:1652-1658` | Custom plan-mode workflow body for the reserved `decompose`/plan kind (`kind-presets.ts:73`). | S | `session-runner.ts`, kind presets |
| 15 | **`Query.initializationResult()` / `accountInfo()` / `usage_EXPERIMENTAL…()`** | `sdk.d.ts:2257`, `:2335`, `:2302` | Account + plan rate-limit utilization (5h/7d windows) for a usage dashboard; subscription-auth context. (`usage` API marked experimental.) | M | `session-runner.ts`, `session-manager.ts`, events |
| 16 | **`Options.includeHookEvents` / `forwardSubagentText`** | `sdk.d.ts:1530-1538`, `:1544-1550` | Richer nested-subagent transcript (full subagent text, hook lifecycle) for the transcript-persistence work (punchlist §C). | S | `session-runner.ts`, `sdk-adapter.ts` |

---

## DELIBERATELY DROPPED — known choices

| Choice | Evidence | Notes |
|---|---|---|
| **Custom in-process `mcp__nightcore__*` MCP server** | Punchlist §A2; `session-runner.ts:128-133` (comment); `tool-registry.ts:45-56` (server still buildable but **`mcpServers()` never passed to `query()`**) | M4.7 locked decision: native SDK tools only (Read/Write/Edit/Bash/Grep/Glob). `ToolRegistry` kept solely for `riskOf` metadata. `@nightcore/tools` + `@nightcore/mcp` stay in tree for a later removal pass (§G). |
| **External MCP server live transports (`Options.mcpServers` for external)** | `tool-registry.ts:59-67` (descriptors only, "wiring their live transports … is deferred") | Listed as descriptors; not connected. (Distinct from #4 above which is about *status* reporting once wired.) |
| **`settingSources: []` strict isolation as the default** | Punchlist §A2; `session-runner.ts:243-252` (comment) | Deliberately kept config-driven (`'user'` default) so the user's own skills/commands "just work"; Nightcore's `PermissionLayer` + `permissionMode` govern the run regardless. Documented as an explicit non-drop. |
| **`bypassPermissions` as default** | Punchlist §A1; `session-runner.ts:138-142` | Explicit user choice for an autonomous studio; per-task override re-enables prompting. |
| **Per-OS worker boundary for sessions** | `session-manager.ts:43-50` (SPIKE comment) | Runners in-process; the SDK already spawns its own CLI subprocess, so a worker_thread per session is likely redundant double-subprocessing. Deferred week-1 decision. |
| **Non-Claude providers** | (project memory `project_nightcore.md`; subscription-auth path `session-runner.ts:53-56`, `:230-235`) | Auth flows through local Claude CLI credentials; no `apiKey` passed by the runner. |
| **Dynamic model list in the web surface** | Punchlist §G | Engine `supportedModels()` works (USED), but the web ships a static list this milestone. |

---

## Top 5 highest-leverage things to wire next

1. **`Options.maxTurns` + `maxBudgetUsd`** (effort S each) — the two missing autonomy guardrails. An unattended bypass-mode studio currently has no hard turn or cost ceiling per task. Result subtypes already map (`sdk-adapter.ts:350` / new `error_max_budget_usd`). Files: `session-runner.ts`, config + Task contract.
2. **`Options.resume` + `forkSession`** (effort M–L) — `sdkSessionId` is *already persisted* (`session-manager.ts:249`) but never used to resume. This turns crashes/HMR/reloads from "lost work" into "reattach," and unlocks fork-from-good-point exploration. Files: `session-runner.ts`, `session-manager.ts`, start-session command.
3. **`Query.getContextUsage()`** (effort S–M) — a live context gauge so long build tasks don't silently hit the context wall; pairs naturally with a future compaction trigger. Files: `session-runner.ts` proxy + new command/event.
4. **Blocking hooks (`PreToolUse` deny + `PostToolUse`/`Stop`)** (effort M) — the `HookBus` skeleton already exists (`hook-bus.ts:36-50`) and is non-blocking by design; promoting it to a decision channel gives policy enforcement (block force-push), auto-verify on `Stop`, and complete tool-result capture for the transcript-persistence work. Files: `hook-bus.ts`, `session-runner.ts`.
5. **`enableFileCheckpointing` + `Query.rewindFiles()`** (effort M) — git-free per-task undo of file changes, the natural backend for the deferred View-changes/rollback UX (punchlist §G). Files: `session-runner.ts`, `session-manager.ts`, command/event.
