# Settings View Audit — Real vs Placeholder

Date: 2026-06-21
Scope: `apps/web/src/components/settings/**`, `packages/contracts/src/config.ts`, `apps/desktop/src-tauri/src/settings.rs`, and consumption sites across the Rust core + `packages/engine`.
Method: read-only trace of each control end-to-end (UI bind → bridge → Tauri persist → read site that changes runtime behavior).

## TL;DR

The Settings view renders **8 nav pages** with ~16 controls, but only **4 controls actually bind to persistence** (model, effort, concurrency, permission mode), and of those only **2 actually change runtime behavior** (max concurrency, permission mode). Everything else is either a roadmap placeholder or persisted-but-dead.

The headline bug: **`defaultModel` / `defaultEffort` / `defaultRunMode` are persisted but never consumed.** New tasks are created with hardcoded `null` (`NewTaskForm.hooks.ts:37-38`, `runMode` `'main'` at `:35`); the engine then falls back to `config.model` from `@nightcore/config` (`session-manager.ts:167`), NOT to the Settings value. So changing "Default model" in Settings has **zero effect on any run**. (Per-task pickers in NewTaskForm work; the global default just isn't wired into them.)

A secondary mismatch: Settings model IDs are short (`opus-4.8`, `SettingsView.tsx:27-31`) while the engine/SDK expects long IDs (`claude-opus-4-8`, `config.ts:44-49`) — so even if `defaultModel` were threaded through, the value wouldn't be a valid SDK model id without mapping.

## Folder structure

Standard folder-per-component (6-file convention): `SettingsView/` (`.tsx`, `.hooks.ts`, `.types.ts`, `.stories.tsx`, `.test.tsx`, `index.ts`) and a reusable `SettingsCard/` presentational primitive. `buildCards()` in `SettingsView.tsx:357` is a large switch that produces the per-page card array; only the `models` and `permissions` cases contain live controls.

## Per-control classification

| Setting | Page | UI control | Persisted? | Consumed where (file:line) | Classification |
|---|---|---|---|---|---|
| Default model | models | `Segmented` (`SettingsView.tsx:371`) → `patchScoped({defaultModel})` | Yes — `settings.rs:24,144` | **Nowhere.** No read site outside settings.rs. NewTaskForm inits `model=null` (`NewTaskForm.hooks.ts:37`); engine uses `config.model` (`session-manager.ts:167`) | **PERSISTED-BUT-UNUSED** |
| Reasoning effort | models | `Segmented` (`:382`) → `patchScoped({defaultEffort})` | Yes — `settings.rs:25,147` | **Nowhere.** NewTaskForm inits `effort=null` (`:38`); engine uses `config.effort` (`session-manager.ts:168`) | **PERSISTED-BUT-UNUSED** |
| Max concurrency | models | `Segmented` (`:400`) → `patchScoped({maxConcurrency})` | Yes — `settings.rs:26,150` | **Yes** — boot: `lib.rs:67`; live resize: `update_settings` → `coordinator::set_max_concurrency` (`settings.rs:293-297`, `coordinator.rs:252,623`) | **REAL** |
| Permission mode | permissions | `Segmented` (`:421`) → `patchScoped({permissionMode})` | Yes — `settings.rs:31,153` | **Yes** — `SettingsStore::sdk_permission_mode` (`settings.rs:198`) ← `resolve_permission_mode` (`sidecar.rs:854-864`, also `coordinator.rs:390`) when a task's own override is absent | **REAL** (global/per-project default for runs) |
| Interactive approval | permissions | `RoadmapToggle on={false}` (`:431`) | No (hardcoded `false`) | n/a — runtime auto-denies | **PLACEHOLDER** (M3) |
| Worktree base dir | worktrees | `FieldValue` static text (`:444`) | No | n/a | **PLACEHOLDER** (M2) |
| Files to copy into worktree | worktrees | `FieldValue` static text (`:448`) | No | n/a | **PLACEHOLDER** (M2) |
| Delete on complete | worktrees | `RoadmapToggle on={settings.cleanupWorktrees}` (`:453`) — read-only, inert | Yes — `settings.rs:35,159` | **Yes (but not editable here)** — `cleanup_worktrees` read at `merge.rs:114`, `coordinator.rs:488` | **REAL backend / PLACEHOLDER UI** — value is consumed, but the toggle can't change it (no onChange) |
| Claude status "Active" | providers | static green dot (`:468`) | No | n/a — cosmetic, not a real auth check | **PLACEHOLDER** |
| Codex "Coming soon" | providers | static text (`:486`) | No | n/a | **PLACEHOLDER** (later) |
| Native notifications | hooks | `RoadmapToggle on={settings.notifyOnComplete}` (`:501`) — read-only, inert | Yes — `settings.rs:37,162` | **Nowhere** — no notification code reads it; no `notify()` call anywhere in core | **PERSISTED-BUT-UNUSED** (and UI can't edit it) |
| Webhook URL | hooks | `FieldValue` static `https://` (`:506`) | No | n/a | **PLACEHOLDER** (M3) |
| Accent / Swatches | appearance | static `Swatches` (`:518`) | `theme` persists (`settings.rs:34,156`) but UI control doesn't bind to it | **Nowhere** — `settings.theme` has no read site in web or core (write-only) | **PERSISTED-BUT-UNUSED** (theme) + **PLACEHOLDER** (swatch UI not wired) |
| Mode (Dark) | appearance | static `Pill` "Dark" (`:519`) | No | n/a — app is dark-only | **PLACEHOLDER** |
| Card density | appearance | `Segmented ... disabled` (`:531`, `onChange={() => {}}`) | No | n/a | **PLACEHOLDER** (M2, explicitly inert) |
| Data directory | paths | `FieldValue` `~/.nightcore` (`:553`) | No (display only) | n/a | **PLACEHOLDER** (display) |
| Project config path | paths | `FieldValue` from `activeProjectPath` (`:558`) | No | reads live prop only | **PLACEHOLDER** (display, but uses real project path) |
| About: version/build/repo | about | static `Pill`/`RepoLink` (`:571-573`) | No | n/a — hardcoded `v0.1.0`, build `0042`, repo `github.com/you/nightcore` | **PLACEHOLDER** (mock data) |

### Scope toggle (Global vs This project)

**Real, for the 4 run-shaping fields only.** `useSettingsView` (`SettingsView.hooks.ts:45-67`): under `project` scope, `effective` reads `settings.projectOverrides[activeProjectId]` with global fallback, and `patchScoped` injects `projectId` into the patch (`:60-61`). The Rust side genuinely splits global vs per-project overrides (`settings.rs:135-143`, `SettingsOverride` `:75`) and consumption respects overrides (`sdk_permission_mode` `:198-205`, `default_run_mode` `:210-217`).

Caveat: per-project scope is **only meaningful for `permissionMode` and `defaultRunMode`** (the two fields with real read sites that take a `project_id`). Per-project `defaultModel`/`defaultEffort`/`maxConcurrency` are written into the override map but never read with a project id, so per-project model/effort is **cosmetic** (same root cause as the global model/effort being unused). `theme`/`cleanupWorktrees`/`notifyOnComplete` are global-only by design (ignored on override targets).

## Backend-supported / needed but NOT surfaced in UI (gaps)

These exist in the `@nightcore/config` contract (`config.ts`) and affect engine behavior, but have no Tauri `Settings` field and no UI control:

- **`logLevel`** (`config.ts:136`, `LogLevelSchema:109`) — real engine/config knob; no UI, not in Tauri Settings struct.
- **`settingSources`** (`config.ts:128`) — controls whether the SDK loads user/project/local Claude config (skills/commands/CLAUDE.md). High-value toggle; absent from UI + Tauri struct.
- **`todoFeatureEnabled`** (`config.ts:132`) — powers the live task panel; absent from UI + Tauri struct.
- **`permissions.allow` / `permissions.deny`** (`config.ts:81-88`) — allow/deny tool lists; the Permissions page shows only `mode`, not the lists.
- **`defaultRunMode`** (`settings.rs:42`) — **persisted and consumed** (`task.rs:314` via `default_run_mode` `settings.rs:210`), but **the Settings UI never exposes it.** The Worktrees page shows static text, not a main/worktree default selector. This is the inverse gap: a real, wired backend setting with no UI surface. (It is settable today only through the per-task NewTaskForm picker.)

## Prioritized fix list

### P0 — make "Default model / effort / run mode" actually do something
The single highest-impact gap. Pick one of two strategies:

1. **Thread settings defaults into task creation (recommended).** In `NewTaskForm.hooks.ts:35-38`, initialize `model`/`effort`/`runMode`/`permissionMode` from the active scope's effective settings (the data is already loaded in `AppShell` via `useSettingsData`, `AppShell.hooks.ts:154`). Pass `settings` into `NewTaskForm`. This makes the global/per-project defaults the seed values for every new task while keeping per-task override.
2. **Or resolve defaults in Rust at create time.** Have `create_task` read `SettingsStore` and stamp `model`/`effort` onto the task when the create call omits them (mirroring how `default_run_mode` is already resolved at `task.rs:314`). This is the more robust fix because it also covers programmatic/auto-loop task creation, not just the dialog.
- **Required either way:** map the short Settings model ids (`opus-4.8`) to SDK ids (`claude-opus-4-8`) — they currently don't match (`SettingsView.tsx:27-31` vs `config.ts:44-49`). Add a mapper or store the long ids in Settings.

### P1 — surface `defaultRunMode` in the Worktrees page
It's already fully wired (`settings.rs:210`, `task.rs:314`) but invisible. Replace the static `FieldValue`/`RoadmapToggle` on the Worktrees page with a live `Segmented` (`main` / `worktree`) bound to `patchScoped({ defaultRunMode })`. Pure UI work; backend is done.

### P1 — make `cleanupWorktrees` editable
The value is consumed (`merge.rs:114`, `coordinator.rs:488`) but the UI is a read-only `RoadmapToggle` (`SettingsView.tsx:453`). Swap for a real toggle calling `patchScoped({ cleanupWorktrees })`. Backend is done; only the control is inert.

### P2 — decide on persisted-but-dead fields: `theme`, `notifyOnComplete`
Both persist but nothing reads them.
- `theme` (`settings.rs:34`): either wire it (apply accent via CSS var on load) or remove the field + the cosmetic Swatches affordance.
- `notifyOnComplete` (`settings.rs:37`): genuinely M3 (no notification subsystem exists). Either implement a native notification on task completion that checks this flag, or leave the field but keep the UI honestly roadmap-badged (it already is).

### P2 — surface real backend knobs the UI hides
Add controls (and Tauri Settings fields, since these live only in `@nightcore/config` today) for `settingSources`, `todoFeatureEnabled`, `logLevel`, and `permissions.allow/deny`. These are real engine behaviors with no user-facing control.

### P3 — replace mock About data
`v0.1.0` / build `0042` / `github.com/you/nightcore` are hardcoded (`SettingsView.tsx:571-573`). Pull version from the Tauri app metadata.

## Evidence anchors (consumption read-sites)

- Concurrency (REAL): `lib.rs:67`, `settings.rs:293-297`, `coordinator.rs:252`.
- Permission mode (REAL): `settings.rs:198-205`, `sidecar.rs:854-864`, `coordinator.rs:390`.
- Run mode (REAL, no UI): `settings.rs:210-217`, `task.rs:314`.
- cleanupWorktrees (REAL backend, inert UI): `merge.rs:114`, `coordinator.rs:488`.
- Model/effort default fallback that BYPASSES settings: `session-manager.ts:167-168` (uses `config.*`, not the Tauri Settings).
- Task create seeds null, never settings: `NewTaskForm.hooks.ts:35-38`.
