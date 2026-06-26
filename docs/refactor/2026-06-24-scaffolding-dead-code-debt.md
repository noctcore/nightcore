# Refactor Plan — Scaffolding / Dead-Code / Structural-Debt Classification

**Date:** 2026-06-24
**Agent:** kirei-refactor (code-level scaffolding/debt lens)
**Scope:** Whole monorepo (Rust core `apps/desktop/src-tauri`, Bun engine `packages/engine` + sidecar/cli/tui, React board `apps/web`, support packages). Goal: distinguish PARKED-INTENTIONAL roadmap seams from STUB-IN-PROGRESS half-wiring from TRUE-DEAD-CODE, plus duplication and god-files.

## Summary

The tree is genuinely clean of removable dead code. `cargo check` emits **zero** warnings; full `eslint .` emits **zero** unused-var/import findings; there are **no** `todo!()`/`unimplemented!()`/`unreachable!()` macros in Rust and only **one** `// TODO` in the whole TS tree (a codegen template). The prior cleanup commit (a31c635) did its job.

What remains is **not** "delete me" — it is **classified scaffolding**: parked roadmap seams (the custom-tools / external-MCP / multi-provider future), a handful of half-wired feature surfaces (task kinds, dynamic model listing), some **stale comments** that claim things aren't wired when they now are, and two real structural smells (one TS god-hook, a numeric-field UI duplication).

**Top priorities (highest leverage):**
1. **`AppShell.hooks.ts` (1101 lines, 14 hooks in one file)** — the one true god-file. It satisfies the `max-hooks-per-file` lint rule only by privatizing 13 sub-hooks behind a single exported `useAppShell`; the rule's intent is circumvented. Split into colocated `*.hooks.ts`.
2. **Numeric override-field duplication** — `LimitField` (TaskDetail.tsx) and `NumberField` (SettingsView.tsx) are near-identical JSX wrappers (the parse logic is already shared via `parseNumericCommit`); only the wrapper duplicates. Extract one `NumberField` component.
3. **Stale "not yet enforcing" comments** — `settings.rs:34` and the generated `Settings.ts` say max_concurrency / maxTurns are "not yet enforced by the M2 loop", but they ARE enforced now (`SlotManager`, `Options.maxTurns`). Doc debt that misleads readers about what's done.

---

## CLASSIFICATION TABLE — "Not Wired Up" items

| Item | Evidence (file:line) | Classification | Notes |
|------|----------------------|----------------|-------|
| `@nightcore/tools` package (echo/fs/git/search/shell tools) | `packages/tools/src/*`; never reaches live SDK options | **TO BE REMOVED** | Slated for removal per the 2026-06-24 decision (native SDK tools + UI-configurable external MCP replaces this). Code still exists; removal not yet executed. |
| `@nightcore/mcp` package (`externalMcpServers`) | `packages/mcp/src/index.ts:26` (empty registry) | **TO BE REMOVED** | Slated for removal per the 2026-06-24 decision. External MCP is now UI-configurable via `Options.mcpServers` directly. Code still exists; removal not yet executed. |
| `echoTool` connectivity demo | `packages/tools/src/echo.ts:9` | **TO BE REMOVED** | Lives inside `@nightcore/tools`; goes with the package removal. |
| `ToolRegistry.buildSdkMcpServer()` / `.mcpServers()` / `.descriptors()` | `packages/engine/src/tool-registry.ts:45,54,59` | **TO BE REMOVED (with packages)** | These three methods assemble `@nightcore/tools`+`@nightcore/mcp` but are **never called** — the custom MCP server is NOT in `Options` (see `session-runner.ts:177-182`). Only `ToolRegistry.riskOf()` is live (`session-runner.ts:148`); **`ToolRegistry` itself is retained** after the packages go because `riskOf` still feeds the permission gate. |
| `task kind = research` (user-selectable) | UI enabled `status.ts:161`; engine preset `kind-presets.ts:73` returns `{}`; Rust policy `kind.rs:43` groups it with reserved (no worktree/verify) | **STUB-IN-PROGRESS** | Selectable in the picker but functionally an unverified build with NO read-only enforcement and no research-specific prompt. Half-wired: surfaced before its behavior exists. |
| `task kind = review` (NOT user-selectable) | UI disabled "coming soon" `status.ts:162`; but real agent preset `kind-presets.ts:64`; real orchestration `kind.rs:36`; **live** via `verification.rs:293 dispatch_reviewer` | **STUB-IN-PROGRESS (inverted)** | The reverse of `research`: the picker hides "Review" but the review machinery IS live — it's the verification gate's reviewer. So `review` as a *task kind* is parked, but `review` as a *mechanism* is done. |
| `task kind = decompose` | reserved everywhere: `status.ts:163`, `kind.rs:43`, `kind-presets.ts:74` | **PARKED-INTENTIONAL** | Defined on the wire, no behavior any tier. Clean reserved seam. |
| Dynamic `listModels()` model discovery | `apps/web/src/lib/models.ts:10,38` "deferred — §G"; curated static set used instead | **PARKED-INTENTIONAL** | Static curated `WEB_MODELS` is the deliberate current behavior; dynamic listing is a roadmap §G item. |
| Settings "Other providers → Codex — Coming soon" row | `SettingsView.tsx:588-600` (badge `later`) | **PARKED-INTENTIONAL** | UI placeholder for the multi-provider seam. Matches the `provider` trait seam in Rust `m2/provider.rs`. |
| Four empty `*.hooks.ts` (`export {}`) | `TaskStatusDot.hooks.ts`, `Sidebar.hooks.ts`, `Splash.hooks.ts`, `SettingsCard.hooks.ts` | **PARKED-INTENTIONAL (convention-mandated)** | NOT dead/removable — `component-folder-structure.ts:36,59` lint rule REQUIRES a sibling `.hooks.ts` for every component. Each is a stub "home for any future state." Deleting them breaks lint. |
| `deps.rs` doc says coordinator "not yet scaffolded" | `m2/deps.rs:6` | **STALE COMMENT** | The coordinator IS scaffolded and registered (`lib.rs:123-127`). Prose lies. |
| `settings.rs` / `Settings.ts` "M2 loop not yet enforcing" max_concurrency/maxTurns | `settings.rs:34`; generated `Settings.ts:11` | **STALE COMMENT** | max_concurrency IS enforced (`lib.rs:70` -> `SlotManager::new`), maxTurns IS threaded (`session-runner.ts:207`). Doc debt. |
| `session-manager.ts` "SPIKE: runners in-process for now" | `session-manager.ts:47-50` | **STALE/ACCEPTED COMMENT** | Documents a deferred crash-isolation decision; accurate but reads as WIP. Confirm with arch agent before touching. |

**No TRUE-DEAD-CODE found.** Every exported symbol resolves to a caller, a test, a generated consumer, or a lint-mandated stub.

## Dead Code to Remove

| File | What | Risk |
|------|------|------|
| (none) | No removable dead code. `cargo check` 0 warnings, `eslint .` 0 unused. | — |

The closest things to "dead" are the `ToolRegistry` MCP-assembly methods (live-dead: defined, never called) — these are slated for removal along with `@nightcore/tools` and `@nightcore/mcp` per the 2026-06-24 decision, but the code still exists. `ToolRegistry` itself is retained because `riskOf` still feeds the permission gate.

## Duplication to Consolidate

### Numeric override-field component (the one real duplicate)
**Files:** `apps/web/src/components/board/TaskDetail/TaskDetail.tsx:52` (`LimitField`), `apps/web/src/components/settings/SettingsView/SettingsView.tsx:137` (`NumberField`)
**Extract to:** `apps/web/src/components/ui/NumberField/` (new folder-per-component) OR `apps/web/src/lib/` if kept as a primitive.
**What it does:** A controlled-on-blur numeric input with inherit-placeholder semantics: `defaultValue ?? ''`, `key={value ?? 'empty'}`, commit on blur/Enter via the SHARED `parseNumericCommit`, identical `[appearance:textfield]` spinner-suppression styling. Differences are purely cosmetic (className widths, prefix slot). Two implementations, structurally identical body. Parameterize the wrapper className/size and collapse to one.
**Note:** The PARSE logic is already DRY (`@/lib/numeric-field.ts`). Only the JSX wrapper duplicates — a small, low-risk extract.

### Event-translation case-arms (NOT a duplicate to collapse — note only)
`apps/web/src/components/board/session-stream.ts:98+` and `apps/tui/src/session-reducer.ts:83+` both switch over the same `NightcoreEvent` union. This is two independent UI consumers of one shared contract — correct by design, do NOT merge.

## Abstractions to Add

### (low priority) Promote the numeric field to a shared UI primitive
**Currently:** Re-declared inline in two feature `.tsx` files (and inline numeric inputs in `NewTaskForm.tsx:109,125`).
**Should be:** `apps/web/src/components/ui/NumberField/` — one inherit-aware numeric input, consumed by TaskDetail, SettingsView, and NewTaskForm.

## Abstractions to Remove

### (none — watch only) ToolRegistry MCP-assembly methods
**Location:** `packages/engine/src/tool-registry.ts:45-67`
**Replace with:** NOTHING yet — this is the parked custom-tools seam, deliberately retained ("stay in the tree for a later removal pass," `session-runner.ts:182`). Flagging for the arch agent's wiring map, not for action.

## Files to Split

| File | Lines (prod) | Problem | Split into |
|------|------|---------|------------|
| `apps/web/src/components/app/AppShell/AppShell.hooks.ts` | 1101 (all prod) | 14 hooks (`useProjectRegistry`, `useSettingsData`, `useAutoLoop`, `useBoard`, `useBlockedIds`, `useWorktrees`, `usePermissions`, `useGauntlet`, `useNewProjectFlow`, `useRouting`, ...) privatized behind one exported `useAppShell` to skirt the `max-hooks-per-file` rule (rule counts only EXPORTED hooks). 88 hook calls in one file. | Extract the domain sub-hooks into the EXISTING colocated component folders' `.hooks.ts` (Board, SettingsView, ProjectsView, PermissionPrompt, GauntletResults all have folders). `useAppShell` becomes a thin composition root. |
| `apps/web/src/components/board/TaskDetail/TaskDetail.tsx` | 682 | Mixes the detail panel + inline presentational sub-components (`LimitField`, field rows). Has an empty-ish `TaskDetail.hooks.ts` sibling already. | Move `LimitField`->shared `NumberField`; pull repeated field-row markup into small components. |
| `apps/web/src/components/settings/SettingsView/SettingsView.tsx` | 658 | Mixes the settings view + inline `NumberField`/`Pill`/section config. | Extract `NumberField` (shared), lift the section-config data out of the component body. |
| `apps/desktop/src-tauri/src/m2/coordinator.rs` | ~744 prod (937 total) | The single stateful auto-loop driver: orchestrator state + tick + reconcile + worktree listing + 5 Tauri commands in one module. Largest Rust PROD file. | Optional: split the Tauri command surface (`start/stop/resume/set_max_concurrency/list_worktrees`) from the tick/reconcile engine. Cohesive today — lower priority. |
| `apps/desktop/src-tauri/src/store/task.rs` | ~618 prod (1219 total, ~50% tests) | Domain model (4 enums + wire impls) + `Task`/`TaskPatch` + 6 Tauri commands in one file. | Optional: split `task/model.rs` (enums + Task + Patch) from `task/commands.rs`. Cohesive; lower priority. |

**Rust god-file caveat:** `worktree.rs` (776), `provider.rs` (723), `store/mod.rs` (578), `settings.rs` (825) are inflated ~40-50% by colocated `#[cfg(test)] mod tests`. Their PRODUCTION bodies are 379 / 586 / 266 / 515 lines — do NOT treat raw line counts as split signal for these.

## Stale Comments to Fix (doc debt — cheap, high clarity value)

| File:line | Says | Reality |
|-----------|------|---------|
| `apps/desktop/src-tauri/src/m2/deps.rs:6` | "auto-loop coordinator (not yet scaffolded)" | Coordinator scaffolded + registered (`lib.rs:123`) |
| `apps/desktop/src-tauri/src/store/settings.rs:34` | "1..=6. Persists now; the M2 loop is not yet enforcing it." | max_concurrency enforced via `SlotManager::new` (`lib.rs:70`) |
| generated `apps/web/src/lib/generated/Settings.ts:11` | "Persists now; the M2 loop is not yet enforcing it." | Fix at the **Rust serde source** (`settings.rs`), NOT the generated file — it's codegen output. |

## Implementation Order

1. **Fix stale comments** (`deps.rs:6`, `settings.rs:34`, regenerate `Settings.ts` via `cargo test`) — XS, zero behavior risk, removes "what's done?" confusion. Do first.
2. **Extract shared `NumberField`** into `components/ui/NumberField/` — needed before deduping the two callers. (Parse logic already shared.)
3. **Replace `LimitField`/`NumberField`** in TaskDetail + SettingsView (and inline inputs in NewTaskForm) with the shared component — depends on step 2.
4. **Split `AppShell.hooks.ts`** — move each domain sub-hook to its existing component-folder `.hooks.ts`; `useAppShell` becomes composition-only. Largest effort; do last on the TS side. Watch `max-hooks-per-file` (<=4 exported hooks/file) and `no-cross-feature-imports`.
5. **(Optional, defer)** Split `coordinator.rs` command surface and `task.rs` model/commands — only if a future change touches them.

## Effort Estimates

| Change | Effort | Risk | Value |
|--------|--------|------|-------|
| Fix 3 stale comments + regen Settings.ts | XS | Low | High (truth-in-docs) |
| Extract shared NumberField | S | Low | Medium |
| Dedupe LimitField/NumberField callers | S | Low | Medium |
| Split AppShell.hooks.ts (14->colocated) | L | Medium | High |
| Split coordinator.rs commands | M | Medium | Low |
| Split task.rs model/commands | M | Low | Low |

## What NOT to Refactor (intentional — leave alone)

- **`@nightcore/tools`, `@nightcore/mcp`** — slated for removal per the 2026-06-24 decision, but the code still exists. Do not delete piecemeal; remove as a coordinated pass.
- **`ToolRegistry.buildSdkMcpServer/mcpServers/descriptors`** — to be removed with the packages above. `ToolRegistry` itself (specifically `riskOf`) must be retained even after the packages go.
- **Four empty `export {}` `.hooks.ts` files** — REQUIRED by the `component-folder-structure` lint rule. Deleting breaks `eslint`.
- **`research`/`review`/`decompose` reserved kinds** — wire shape is intentional; `review` machinery is already live via the verification gate. Don't "clean up" the reserved variants.
- **All `apps/web/src/lib/generated/*` and Rust `contracts/generated.rs`** — codegen output. Edit the source-of-truth (Rust serde / zod), never the generated file.
- **session-stream.ts vs session-reducer.ts parallel switches** — two valid consumers of one contract, not duplication.
- **Test-heavy Rust files** (worktree/provider/store-mod) — line counts are test-inflated, not god-files.
