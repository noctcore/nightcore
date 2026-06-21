# M4.6 Contract — Worktree Modes + Verification Lifecycle Fix

**Date:** 2026-06-21 · **Status:** FROZEN (orchestrator-owned). Fixes the dogfood bug + makes worktrees opt-in (AutoMaker-style). Serde-additive. Grounded in `docs/research/2026-06-21-worktree-model-automaker-vs-nightcore.md`.

**Locked decisions (user):** default run mode = **main**; worktree UX = **AutoMaker-style switcher** (adapt AutoMaker's UI); the verification gate **runs on main too** (against the working-tree diff, never auto-merging).

**Reuse:** adapt these AutoMaker components (read-only ref at `/Users/shirone/Documents/Projects/automaker`) into Nightcore's folder-per-component + cosmic-dark + `@nightcore/eslint-plugin` conventions: `apps/ui/src/components/views/board-view/worktree-panel/worktree-panel.tsx` + `components/worktree-tab.tsx` (the switcher), `board-view/shared/work-mode-selector.tsx` (create-time toggle), `board-view/dialogs/view-worktree-changes-dialog.tsx` (diff view). Match their UX shape, not their stack (they're Zustand/server; we're Tauri).

---

## A. Verification lifecycle fix (the dogfood bug) — Rust core, ship first

Root cause: the build session leaves its edits **uncommitted** in the worktree, then the reviewer prompt makes `git diff <base>...HEAD` authoritative → empty range → "not implemented," while the change sits right there uncommitted.

1. **Commit before review (worktree mode):** in `sidecar.rs::handle_build_completed`, before `dispatch_reviewer_for`, commit the build's work in the worktree via the existing `worktree::commit` (message derived from the task title). Skip cleanly if there's nothing to commit (surface that as a no-op, distinct from a real empty result).
2. **Working-tree-aware reviewer prompt:** rewrite the reviewer instructions so working-tree state is authoritative, not just a commit range. Tell it to run `git status --porcelain`, `git diff` (unstaged), `git diff --cached` (staged), list untracked files, AND `git diff <base>...HEAD` when a base/branch exists — and judge the union. Never conclude "no changes" from an empty `base..HEAD` alone.
3. **Gate on main mode (no branch):** a `main`-mode task (§B) has no worktree/branch — the reviewer runs in the project root and diffs the **working tree vs HEAD** (`git status` + `git diff` + untracked). PASS → `verified`. **`main`-mode tasks NEVER auto-merge** (no branch to merge); `merge_task` refuses them with a clear message; `commit_task` may still commit in place on the current branch.
4. Tests: a temp repo where the build wrote an uncommitted file → after commit-before-review the change is committed and the reviewer-visible diff is non-empty; a `main`-mode task with a dirty working tree is reviewable; `merge_task` on a `main` task is refused.

---

## B. RunMode — explicit per-task choice — Rust core + contracts

- **`RunMode` enum** `main` (default) | `worktree`, snake_case wire, serde default `Main`. Add `run_mode: RunMode` to `Task` (serde-additive `#[serde(default)]`) and to `TaskPatch`. Settable at create + editable pre-run (not mid-run).
- **`resolve_worktree` branches on `run_mode`** (in both `coordinator.rs` and `sidecar.rs`):
  - `worktree` → allocate `nc/<taskId>` as today (record `branch`).
  - `main` → run in the **project root** (cwd = project path), no worktree, `branch = None`.
- **Relax the dirty-base guard for `main` mode:** the current `is_worktree_clean` refusal must NOT block a `main`-mode run (the user is intentionally working in the project tree). Keep the clean-base guard for `worktree` allocation only (you can't branch a worktree off a dirty index cleanly — keep that check there).
- **Project-default + global setting:** add a `default_run_mode` to `SettingsStore` (global + per-project override), default `main`. A new task inherits it unless the create call overrides.
- Back-compat: legacy tasks (no `run_mode`) load as `main`. Extend the pinning test.

## C. Worktree monitoring backend — Rust core

- Command **`list_worktrees(project)`** → for the active project, the set of live worktrees: `{ branch, path, taskIds, dirty: bool, aheadOfBase: u32 }` (read-only git status per worktree; reuse/extend `worktree.rs`). Drives the switcher's monitor indicators. Keep it cheap; tolerate a missing/locked worktree.
- One worktree per task stays the v1 model (branch `nc/<taskId>`); the switcher groups tasks by `branch`. (Multi-task-per-worktree shared boards = explicit follow-up, out of scope here.)
- `commit_task`/`merge_task` already exist (M3); merge_task now also refuses `main`-mode tasks (§A.3).

## D. Worktree switcher + work-mode UI — Web (apps/web), adapt AutoMaker

All new components obey folder-per-component (.hooks/.types/.parts/.stories/.test + barrel), cosmic-dark stories, `lib/bridge.ts` sole Tauri seam.

1. **Mirror the model:** add `runMode` ('main'|'worktree') to the web Task type + create/patch payloads; `RunMode` default 'main'.
2. **Work-mode selector at task creation** (adapt `work-mode-selector.tsx`): a Main vs Worktree choice in `NewTaskForm` (default Main), with a one-line explainer ("Main edits the project directly; Worktree isolates this task on its own branch"). Thread `runMode` through `createTask`.
3. **Worktree switcher** (adapt `worktree-panel.tsx` + `worktree-tab.tsx`): a tab/segment bar above the board — **"Main"** tab + one tab per live worktree (from `listWorktrees`, fallback to distinct task branches). Selecting a tab sets the **active worktree** (web state, default Main) and **filters the board** to that worktree's tasks (Main = `runMode==='main'`; a worktree tab = tasks whose `branch` matches). Each tab shows a monitor indicator (running count / dirty / ahead). `listWorktrees` + active-worktree state added; `runWorktrees`/`listWorktrees` bridge fn.
4. **Branch chip + per-task affordances:** worktree-mode cards show their branch; main-mode cards show a "main" chip. A "View changes" affordance (adapt `view-worktree-changes-dialog.tsx`) can show the task's diff — wire to a backend diff read if cheap, else defer the dialog and keep the chip (note which you did).
5. New bridge fns: `listWorktrees`; `runMode` on create/patch. Reuse existing `commitTask`/`mergeTask`; hide/disable Merge for `main`-mode tasks (per §A.3).

---

## E. Guardrails
- Serde-additive; legacy tasks load as `run_mode=main`. Existing suites stay green (110 cargo / 165 web / 39 plugin / 219 node) + the new tests.
- Don't break M4: worktree-mode tasks keep the full gate→commit→merge flow; the only behavior change is the commit-before-review fix (§A) and that worktrees are now opt-in.
- The reviewer/commit must never touch the user's main checkout outside the intended tree; `main`-mode runs in the project root by design (that IS the user's tree — that's the point), but still no force, no destructive git.
- Secrets/log discipline from M4.5 holds (diff bodies → debug only, never info/telemetry).
- Out of scope (explicit follow-ups): multi-task-per-worktree shared boards, the full create/merge/commit/discard dialog suite, and the broader dogfood punch-list (bypass permission mode, tool-arg display, transcript persistence, markdown rendering, per-task model+effort) — tracked separately.
