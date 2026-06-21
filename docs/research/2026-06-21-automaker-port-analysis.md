# Research: AutoMaker → Nightcore Port Analysis

**Date:** 2026-06-21
**Agent:** kirei
**Status:** complete
**Clone method:** `git clone --depth 1 https://github.com/AutoMaker-Org/automaker /tmp/automaker-analysis` (succeeded; read source directly).

## Problem
The user is pivoting Nightcore from a generic thin Claude CLI/TUI harness into a **from-scratch, simplified reimagining of AutoMaker** — an autonomous AI development studio — while reusing Nightcore's existing clean Bun monorepo + Claude-Agent-SDK engine as the foundation. This document maps what AutoMaker actually does, ranks what is worth porting, and maps each ported piece onto Nightcore's existing package/app layout (flagging architectural gaps).

---

## ANALYSIS — What AutoMaker Is Today

### Build/run model
AutoMaker is **not** a CLI. It is a **desktop + web app with a long-running backend daemon**:

- `apps/ui/` — React 19 + Vite 7 + **Electron 39**, TanStack Router, Zustand 5, Tailwind 4. Kanban board UI (port 3007).
- `apps/server/` — **Express 5 + WebSocket (`ws`)** backend (port 3008), `node-pty` for terminals. This is the real brain; UI is a client of it.
- `libs/*` — 8 shared `@automaker/*` packages (types, utils, prompts, platform, model-resolver, dependency-resolver, spec-parser, git-utils).
- Ships with **Docker** (`Dockerfile`, multiple compose files) and an interactive launcher (`start-automaker.mjs` / `.sh`). Web mode and Electron mode share the same server.

The architecture is **surface (UI) ↔ HTTP/WS ↔ server daemon**. Nightcore's hard engine↔surface boundary maps cleanly onto this, but AutoMaker's "engine" is a persistent multi-project daemon, not a per-invocation process.

### Core concept: the Kanban autonomous loop
The product thesis (`README.md`, `CLAUDE.md`): **you describe features on a Kanban board; AI agents implement each one autonomously in an isolated git worktree.** The lifecycle is `backlog → ready → in_progress → waiting_approval → verified → completed` (`libs/types/src/pipeline.ts` `FeatureStatusWithPipeline`).

Core domain object = **Feature** (`libs/types/src/feature.ts`):
- `id, title, category, description, status, priority, dependencies[]`
- `branchName` (worktree branch), `model`, `thinkingLevel`, `reasoningEffort`, `providerId`
- `planningMode` (`skip | lite | spec | full`), `requirePlanApproval`, `planSpec` (with parsed `tasks[]`, approval state)
- `imagePaths[]`, `textFilePaths[]` (multimodal feature input), `descriptionHistory[]`
- `excludedPipelineSteps[]`, `skipTests`, `summary`, `error`

### The orchestration engine (the crown jewels — all in `apps/server/src/services/`)
This is where AutoMaker's real value lives — ~60 services. The important ones:

- **`auto-mode/` (facade.ts, global-service.ts, coordinator)** — the **auto-loop**: continuously scans the board for eligible features and dispatches them. `AutoLoopCoordinator` (`auto-loop-coordinator.ts`) manages per-worktree loop lifecycle, sleep intervals, and a **consecutive-failure circuit breaker** (3 failures / 60s window → pause). Eligibility gated by `areDependenciesSatisfied` (`@automaker/dependency-resolver`).
- **`ConcurrencyManager` (`concurrency-manager.ts`)** — **lease-based slot manager** with reference counting; caps parallel running features (`DEFAULT_MAX_CONCURRENCY`), tracks `AbortController` per running feature. This is the queue/scheduler.
- **`AgentExecutor` (`agent-executor.ts`)** — the core streaming execution engine. Wraps the provider, parses task markers from the model stream (`parseTasksFromSpec`, `detectTaskStartMarker`, `detectTaskCompleteMarker`), debounced disk writes, stream heartbeat, `DEFAULT_MAX_TURNS = 10000`.
- **`PipelineOrchestrator` (`pipeline-orchestrator.ts`) + `pipeline-service.ts`** — runs configurable **multi-step pipelines** per feature (`PipelineStep{ instructions, order }`), with test runner integration and auto-merge between steps.
- **`PlanApprovalService` (`plan-approval-service.ts`)** — plan-before-build gate: generate a spec/plan, **block on human approval** (with timeout → auto-reject, and orphaned-approval recovery after server restart).
- **Worktree stack** — `worktree-service.ts`, `worktree-resolver.ts`, `worktree-branch-service.ts` + `@automaker/git-utils` (`branch.ts`, `conflict.ts`, `diff.ts`, `merge`). Creates per-feature git worktrees, copies configured files, resolves merge conflicts (optionally handing conflicts back to the agent).
- **Git workflow services** — merge, rebase, cherry-pick, stash, push, pull, sync, branch-commit-log, PR creation (`pr-service.ts`), PR review comments (`pr-review-comments.service.ts`, `github-pr-comment.service.ts`).
- **`IdeationService` (`ideation-service.ts`)** — AI brainstorming sessions → ideas → convert idea to feature; project analysis.
- **Spec/planning** — `spec-parser.ts` + `@automaker/spec-parser` (XML↔spec), `SpecOutput` structured-output schema (`libs/types/src/spec.ts`), `backlog-plan` route (AI decomposes a goal into a backlog of features).
- **`TestRunnerService`, `dev-server-service.ts`, `init-script-service.ts`** — runs tests/dev servers/setup scripts in the worktree.
- **`EventHookService` (`event-hook-service.ts`) + `ntfy-service.ts` + `notification-service.ts`** — user-defined hooks (shell / HTTP webhook / ntfy push) fired on `feature_created`, `feature_success`, `feature_error`, `auto_mode_complete`, etc. Plus `event-history-service.ts` for replay.
- **`TypedEventBus` (`typed-event-bus.ts`)** — internal typed event spine; `RecoveryService` restores in-flight state after a restart.
- **`TerminalService` (`terminal-service.ts`)** — full `node-pty` terminals streamed over WS.
- **`SettingsService`** — layered global + per-project settings; `FeatureTemplate` (`libs/types/src/settings.ts`) = reusable feature templates; `templates` route clones GitHub starter repos.

### Provider integrations (the DROP candidates)
AutoMaker is aggressively **multi-provider**. `apps/server/src/providers/`:
- `claude-provider.ts` (Claude Agent SDK), `codex-provider.ts` (`@openai/codex-sdk`), `copilot-provider.ts` (`@github/copilot-sdk`), `gemini-provider.ts`, `cursor-provider.ts`, `opencode-provider.ts`, `mock-provider.ts`, plus `cli-provider.ts` for generic CLI agents.
- Abstracted behind `BaseProvider` (`base-provider.ts`) + `provider-factory.ts` + `@automaker/model-resolver`. Routes exist per provider (`routes/claude`, `routes/codex`, `routes/gemini`, `routes/zai`). Per-provider usage services (`claude-usage-service.ts`, `codex-usage-service.ts`, etc.).
- `ModelProvider = 'claude' | 'cursor' | 'codex' | 'opencode' | 'gemini' | 'copilot'` (`libs/types/src/settings.ts`).

**All of this multi-provider machinery is out of scope for Nightcore (Claude SDK only).** Nightcore already has the equivalent of `claude-provider.ts` in `packages/engine/sdk-adapter.ts`.

### Data storage
File-based, no DB — matches Nightcore's philosophy. Per-project `.automaker/` (features as JSON + images, `context/`, `settings.json`, `spec.md`, `analysis.json`); global `DATA_DIR` (`settings.json`, `credentials.json`). Maps directly onto Nightcore's `~/.nightcore/` + per-project `.nightcore/`.

---

## How Nightcore Maps Today
Existing Nightcore (read from source):
- `packages/contracts` — zod spine: `SessionRecord`, `SurfaceCommand`, `NightcoreEvent`, config, models, tools.
- `packages/engine` — `SessionManager` (monotonic-id supervisor, N concurrent `SessionRunner`s, graceful-degrade), `PermissionLayer`, `ToolRegistry`, `HookBus`, `sdk-adapter`.
- `packages/storage` — append-only JSONL `SessionStore` (no transcripts; SDK owns those).
- `packages/tools` — in-process SDK tools (fs, git, search, shell, echo, read-file).
- `apps/cli` (working), `apps/tui` (OpenTUI+React; session reducer, tool formatting, slash commands).

**Key insight:** Nightcore's `SessionManager` + `ConcurrencyManager` discipline is *already* a primitive version of AutoMaker's `ConcurrencyManager`/auto-loop. The session = one agent run. AutoMaker adds a **persistent task/feature registry** and an **autonomous loop** on top of that primitive. That loop + worktree isolation is the gap.

---

## PRIORITIZED PORT LIST

### TIER 1 — MUST-PORT (the core value; without these it isn't AutoMaker)

| # | Capability | Source in AutoMaker | Why | Effort |
|---|-----------|---------------------|-----|--------|
| 1 | **Feature/Task model + registry** | `libs/types/feature.ts`, `feature-loader.ts`, `feature-state-manager.ts` | The central domain object. Everything orbits a persisted Feature with status lifecycle. | M |
| 2 | **Status lifecycle** (`backlog→ready→in_progress→waiting_approval→verified→completed`) | `pipeline.ts` `FeatureStatusWithPipeline` | The Kanban semantics. Simplify the enum. | S |
| 3 | **Auto-loop coordinator** | `auto-loop-coordinator.ts`, `auto-mode/facade.ts` | THE differentiator: autonomously pulls eligible features and runs them. Includes failure circuit-breaker. | L |
| 4 | **Concurrency/slot manager** | `concurrency-manager.ts` | Bounded parallel execution with abort handles. Nightcore's SessionManager is half of this already. | M |
| 5 | **Per-feature git worktree isolation** | `worktree-service.ts`, `worktree-resolver.ts`, `@automaker/git-utils` | Lets N agents run in parallel without clobbering each other. Core safety property. | L |
| 6 | **Agent execution → feature binding** | `agent-executor.ts`, `execution-service.ts` | Bridges a SessionRunner to a Feature: build prompt from feature, stream, capture summary/error, update status. | M |
| 7 | **Dependency ordering** | `@automaker/dependency-resolver`, `areDependenciesSatisfied` | Features declare `dependencies[]`; loop only runs when deps are done. Small + high value. | S |

### TIER 2 — NICE-TO-HAVE (clear value, defer to v2)

| # | Capability | Source | Why defer | Effort |
|---|-----------|--------|-----------|--------|
| 8 | **Plan-before-build approval gate** | `plan-approval-service.ts`, `planSpec` | Big UX win, but adds a blocking human-in-loop state machine + recovery. Needs an interactive surface. | M |
| 9 | **Planning modes** (`lite/spec/full`) + spec parsing into tasks | `spec-parser.ts`, `@automaker/spec-parser`, `SpecOutput` | Strong feature; XML round-trip is heavy. Start with `skip` + maybe `lite`. | M |
| 10 | **Custom multi-step pipelines** | `pipeline-orchestrator.ts`, `pipeline-service.ts` | Powerful but complex; a single implement-step covers 80%. | L |
| 11 | **Auto-merge + conflict-to-agent** | `merge-service.ts`, `conflict.ts` | Needed for true autonomy at scale; defer until worktrees are stable. | M |
| 12 | **Event hooks (shell/HTTP/ntfy) + notifications** | `event-hook-service.ts`, `ntfy-service.ts` | Nightcore already has `HookBus`; extend it. Notifications are a thin add. | S |
| 13 | **Feature templates / backlog-plan generation** | `FeatureTemplate`, `routes/backlog-plan` | "Decompose a goal into a backlog" is a great onboarding flow. | M |
| 14 | **Test runner / dev-server / init scripts in worktree** | `test-runner-service.ts`, `dev-server-service.ts` | Closes the verify loop. Defer to pipeline work. | M |
| 15 | **Ideation sessions** | `ideation-service.ts` | Nice top-of-funnel; not core to the build loop. | M |
| 16 | **Recovery after restart** | `recovery-service.ts`, orphaned-approval recovery | Important once the daemon is long-running; trivial while sessions are ephemeral. | S |

### TIER 3 — DROP (and why)

| Capability | Why drop |
|-----------|----------|
| **All non-Claude providers** (codex, copilot, gemini, cursor, opencode) + `BaseProvider`/`provider-factory`/`model-resolver`/per-provider usage services + `routes/{codex,gemini,zai,claude}` | Hard constraint: Claude Agent SDK only. Nightcore's `sdk-adapter` already is the Claude provider. Deleting this removes ~30% of the server surface. |
| **Electron desktop shell + React/Vite/Tailwind/TanStack/Zustand UI** | Nightcore is TUI-first. The whole `apps/ui` is replaced by `apps/tui` (+ optional later web). |
| **Express + WebSocket HTTP transport** | Nightcore uses in-process typed `SurfaceCommand`/`NightcoreEvent` streams, not HTTP. Only needed if a remote/web surface is wanted (open question). |
| **node-pty terminal service + terminal themes** | Heavy; the SDK's own shell tool + Nightcore's `shell` tool cover agent needs. Interactive user terminals are a desktop-app affordance. |
| **Docker / compose / start-automaker launcher** | Nightcore ships as `bun` + single binary; no container story needed for a single-user local tool. |
| **PR creation / PR review-comment ingestion / GitHub integration** | Useful but a large surface tied to remote workflows; out of scope for a simplified local tool (revisit far later). |
| **Multi-profile credential management (`credentials.json`)** | Nightcore intentionally brokers no credentials (inherits `~/.claude`). |
| **`zai`/codex usage dashboards, model migration, cursor/opencode config managers** | All provider-specific. |

**Ranking rationale (value ÷ effort):** Tier 1 items 1, 2, 7 are cheap and unlock the model; items 3, 5 are the expensive-but-defining work. Do 1/2/4/6/7 first (the registry + loop scaffolding reusing SessionManager), then 3, then 5 (worktrees) as the isolation upgrade.

---

## STRUCTURE MAPPING — where each port lands

| Ported piece | Lands in | Notes |
|---|---|---|
| Feature/Task schema, status enum, planSpec | `packages/contracts` (new `task.ts` / `feature.ts`) | Extend the zod spine; sits alongside `session.ts`. |
| Task registry persistence (JSONL) | `packages/storage` (new `TaskStore`) | Mirror `SessionStore`; per-project `.nightcore/tasks/`. |
| Dependency resolver | `packages/shared` or new `packages/planning` | Pure function; small. |
| Auto-loop coordinator + concurrency manager | **NEW `packages/orchestrator`** (or fold into `engine`) | This is the missing piece. Wraps `SessionManager`; owns the scan-and-dispatch loop, slot leasing, circuit breaker. Keep it engine-side of the boundary. |
| Agent execution → feature binding (build prompt, capture summary/status) | `packages/engine` (extend `SessionRunner`/new `TaskRunner`) | Reuses `sdk-adapter`; adds feature-aware prompt building + status transitions. |
| Worktree manager | **NEW `packages/worktree`** + extend `packages/tools/git.ts` | Git worktree create/resolve/copy/merge. Effectively ports `@automaker/git-utils` + `worktree-service`. |
| Plan-approval gate | `packages/engine` (new state) + surface UI in `apps/tui` | New `awaiting-approval` session/task status already half-exists in `SessionStatusSchema`. |
| Spec/planning + task parsing | `packages/skills` or new `packages/planning` | `skills` currently a placeholder — natural home for planning-mode presets + spec parser. |
| Pipelines | `packages/orchestrator` (pipeline config in `contracts`) | Tier 2; build after single-step works. |
| Event hooks / notifications | extend `packages/engine/HookBus` + `packages/config` | HookBus already exists; add shell/HTTP/ntfy actions + triggers. |
| Templates / backlog generation | `packages/skills` + `apps/cli`/`apps/tui` command | |
| Kanban surface (board view, feature cards, approvals) | `apps/tui` (new views/commands) | Replaces AutoMaker's React board with OpenTUI panels. |
| Ideation | `packages/skills` + TUI command | Tier 2. |
| Recovery | `packages/orchestrator` | Re-hydrate in-flight tasks from `TaskStore` on startup. |

### What the current Nightcore arch is MISSING to support AutoMaker's model
1. **A task/feature registry** — Nightcore only has `SessionRecord` (one prompt → one run). AutoMaker needs a persisted, mutable, status-bearing **Task** that outlives a single session. → new `contracts/task.ts` + `storage/TaskStore`.
2. **A job/queue runner (the auto-loop)** — nothing in Nightcore continuously scans pending work and dispatches it. `SessionManager` runs sessions on command but has no scheduler. → new `packages/orchestrator` with the scan-loop + lease-based concurrency + circuit breaker.
3. **A worktree manager + project registry** — Nightcore runs in one cwd; it has no concept of "this project has N feature branches in N worktrees." → new `packages/worktree` + a project registry (could live in `config`/`storage`).
4. **A long-running host** — Nightcore's CLI is invoke-and-exit. AutoMaker's loop implies a **persistent process** (daemon or a long-lived TUI). Decision needed (see open questions).
5. **An approval/blocking state machine** — partial: `SessionStatusSchema` already has `awaiting-permission`; needs extension to feature-level plan approval.

---

## Recommended Approach
Build in three milestones on top of the existing engine, reusing `SessionManager` rather than replacing it:

- **M1 — Task spine (Tier 1: 1,2,4,6,7).** Add `contracts/task.ts` + `storage/TaskStore` + a `packages/orchestrator` that, on command, runs a single Task via a `SessionRunner`, captures summary/status, respects `dependencies[]` and a concurrency cap. Surface a minimal board in `apps/tui`. No worktrees yet — run in cwd, serial or low concurrency. This already demonstrates the AutoMaker value.
- **M2 — Autonomy + isolation (Tier 1: 3,5).** Add the auto-loop (scan eligible → dispatch) and `packages/worktree` for per-task branch isolation, enabling real parallelism. Add the failure circuit-breaker.
- **M3 — Quality gates (Tier 2: 8,9,12,14).** Plan-approval gate, lite planning mode, hook/notification extensions, test-runner verify step.

Keep the hard engine↔surface boundary: the orchestrator emits `NightcoreEvent`s and consumes `SurfaceCommand`s exactly like `SessionManager`, so CLI/TUI/(future web) all drive it identically.

## Files to Modify / Create (in Nightcore)
- `packages/contracts/src/task.ts` — NEW: Task schema (id, title, description, status, deps, model, planMode, branchName, summary, error).
- `packages/contracts/src/commands.ts` / `events.ts` — extend with task/loop commands + events.
- `packages/storage/src/task-store.ts` — NEW: JSONL TaskStore mirroring SessionStore.
- `packages/orchestrator/` — NEW PACKAGE: auto-loop coordinator + concurrency/slot manager + recovery.
- `packages/worktree/` — NEW PACKAGE: git worktree create/resolve/merge (port `@automaker/git-utils`).
- `packages/engine/src/session-runner.ts` — extend to a task-aware runner (feature-prompt building, status transitions).
- `packages/skills/` — planning-mode presets + spec parser (port `@automaker/spec-parser` subset).
- `packages/engine/src/hook-bus.ts` + `packages/config` — extend for event-hook actions/notifications.
- `apps/tui/` — NEW board/task views, approval prompts, loop start/stop commands.

## Reference Files (do not modify — patterns to copy from AutoMaker clone at /tmp/automaker-analysis)
- `apps/server/src/services/auto-loop-coordinator.ts` — loop lifecycle + circuit breaker.
- `apps/server/src/services/concurrency-manager.ts` — lease-based slot model.
- `apps/server/src/services/agent-executor.ts` — stream-to-feature binding, task markers.
- `apps/server/src/services/worktree-service.ts` + `libs/git-utils/*` — worktree + git.
- `apps/server/src/services/plan-approval-service.ts` — approval state machine + recovery.
- `libs/types/src/feature.ts`, `pipeline.ts`, `spec.ts` — domain types to simplify.
- `apps/server/src/providers/claude-provider.ts` — confirms the Claude-SDK path Nightcore already has.

## Risks & Gotchas
- **Daemon vs ephemeral CLI tension** is the biggest architectural fork — the auto-loop wants a persistent host; Nightcore's CLI is invoke-and-exit. Resolve before M2.
- **Worktree management is the highest-effort, highest-risk port** (file copy, merge conflict handling, branch cleanup). AutoMaker has ~10 git services; resist porting all of it.
- **Don't port the provider abstraction.** Deleting `BaseProvider`/factory is a feature; binding straight to `sdk-adapter` keeps the engine thin. The Claude SDK billing-pool change noted in AutoMaker's README (June 15 2026) is a usage/auth consideration, not an architecture one.
- **`Feature` has a `[key: string]: unknown` catch-all** — do NOT copy that into the zod contract; keep Nightcore's schema strict.
- **Concurrency + abort correctness**: AutoMaker's lease-counting exists because of nested calls (resume→execute). Keep the slot model simple unless you actually have nested dispatch.
- **Scope creep**: AutoMaker has ~60 services and 32 route groups. The MUST-PORT set is ~7 concepts. Aggressively resist the long tail (PRs, terminals, ideation, usage dashboards, Docker).

## How to Verify
- M1: create 3 tasks with a dependency chain in `.nightcore/tasks/`; run the orchestrator; confirm they execute in dependency order, statuses transition in JSONL, and a summary is captured — all via the existing `SessionManager`.
- M2: start the auto-loop with `maxConcurrency=2`; confirm 2 tasks run in parallel in separate worktrees, the circuit breaker pauses after 3 rapid failures, and worktrees are cleaned up on completion.
- Boundary check: the TUI drives everything through `SurfaceCommand`s and renders only `NightcoreEvent`s (no direct orchestrator calls), proving the surface boundary held.

## Open Questions (decisions for the user)
1. **Surface direction:** Stay TUI-first, or does the AutoMaker model push toward a long-running **daemon + thin TUI client**, or even a web/desktop board later? (AutoMaker is fundamentally a board UI over a daemon.) This drives whether `packages/orchestrator` runs in-process in the TUI or as a separate host.
2. **Persistence host:** Should the auto-loop run only while the TUI is open (ephemeral) or as a detached background daemon that the TUI attaches to? Affects recovery (Tier 2 #16) priority.
3. **Worktrees in v1 or v2?** Without worktrees you can't safely run features in parallel; with them M1 grows significantly. Acceptable to ship M1 serial-in-cwd first?
4. **Planning depth:** Ship with `skip` only, or include `lite` planning (and therefore the plan-approval gate) in the first milestone?
5. **Project registry scope:** Single active project (like the current cwd model) or multi-project board like AutoMaker? Multi-project is a meaningful arch addition.
6. **HTTP/WS transport:** Keep everything in-process (no Express), accepting that a future web surface would need a transport added later — confirm we're OK deferring that.
