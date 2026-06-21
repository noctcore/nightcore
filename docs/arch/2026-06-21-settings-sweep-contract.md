# Settings Full-Sweep Contract — make Settings real

**Date:** 2026-06-21 · **Status:** FROZEN (orchestrator-owned). Serde-additive.
**Grounding:** `docs/research/2026-06-21-settings-view-audit.md` (read it fully first — every claim below has a file:line there).
**Runs in:** worktree A, in parallel with the SDK-guardrails contract (worktree B).

## Ownership / boundaries (avoid collisions with worktree B)
- **You OWN:** `apps/web/src/components/settings/**`, `apps/web/src/components/board/NewTaskForm/**`, the settings seam in `apps/web/src/lib/bridge.ts`, `apps/desktop/src-tauri/src/settings.rs`, the **settings** portion of `packages/contracts/src/**` config schema, the desktop notification path, and the model/effort/run-mode **default-resolution** in `apps/desktop/src-tauri/src/task.rs` / launch sites.
- **DO NOT TOUCH (worktree B owns):** `packages/engine/**`, anything about `maxTurns` / `maxBudgetUsd` / session `resume` / `forkSession` / `getContextUsage` / file checkpointing. If you see those, leave them.
- Keep all suites green: `bun run test:rust`, `test:web`, `test:node`, `test:plugin` (or `test:all`).

## A. P0 — Default model + effort must actually affect new tasks
The bug: new tasks hardcode `null` (`NewTaskForm.hooks.ts:37-38`), engine falls back to `@nightcore/config`, never the Settings value; and Settings stores SHORT ids (`opus-4.8`) while the SDK needs LONG ids (`claude-opus-4-8`).
1. **Single source of truth for model ids.** Align the Settings model option `value`s with the SDK long ids used in `@nightcore/config` (`config.ts:44`). Either store long ids directly (preferred) or add one shared short→long mapper used at the seam — no duplicate maps. The picker LABEL can stay friendly ("Opus 4.8"); the persisted/sent value must be the SDK id.
2. **Resolve defaults at creation, mirroring `default_run_mode`.** In Rust `create_task` (`task.rs`, same place `default_run_mode` is applied at `:314`), when the task's `model`/`effort` are `None`, fill them from the resolved default (per-project override → global default). This makes the Settings default authoritative without the web having to seed it. Keep `NewTaskForm` able to override explicitly (it already has the pickers).
3. **Per-project overrides must be READ, not just written.** Today only `permissionMode` reads the per-project map. Extend the resolver so per-project `model`/`effort`/`concurrency` overrides are honored (the write path already exists in `SettingsView.hooks.ts:45-67` / `settings.rs:135-217`). If concurrency-per-project is out of reach cleanly, scope it to model+effort and note why.
4. Tests: pin the new short→long mapping; test that a `None`-model task resolves to the project default then the global default.

## B. P1 — Surface the wired-but-hidden + make the inert toggle live
- **`defaultRunMode`** is fully wired in the backend (`settings.rs:210`, `task.rs:314`) but has no UI. Add a selector (main | worktree) on the Worktrees settings page.
- **`cleanupWorktrees`** backend works (`merge.rs:114`, `coordinator.rs:488`) but the UI toggle is read-only/inert. Make it an editable, persisted toggle.

## C. notifyOnComplete → real OS notification
- The flag is persisted but nothing reads it. Wire a desktop notification (Tauri notification plugin — add it if absent, request permission once) fired from the Rust core when a task transitions to a terminal state (Done and Failed), gated on `notify_on_complete`. Title/body: task title + outcome. No secrets in the body.
- Keep it on the same Rust path that finalizes a task; mirror the M4.5 logging discipline (no token/secret logging).

## D. Remove the dead mock controls (keep Settings honest)
Remove these controls (and their dead persisted fields where the field exists ONLY to back a removed control):
- Interactive-approval toggle, worktree-dirs input, webhook input, density swatches.
- **Theme switcher** — the app is cosmic-dark only (`styles.css` hardcodes `color-scheme: dark`); light mode was explicitly NOT chosen. Remove the theme control and the unused `theme` setting field.
Leave a clean page — don't leave empty section shells.

## E. Real About data
Replace hardcoded `v0.1.0` / build `0042` / `github.com/you` with real values (app version from the Tauri/package metadata; the real repo URL). If a value isn't readily available at runtime, source it from a build-time constant rather than a fake literal.

## F. Guardrails
- Serde-additive; legacy settings/tasks load with new fields defaulting to inherit. Update the settings pinning test in `settings.rs`.
- `lib/bridge.ts` is the only Tauri seam from web. Folder-per-component + cosmic-dark stories/tests for any new web component; `@nightcore/eslint-plugin` must stay green.
- No secret/token logged or persisted.
