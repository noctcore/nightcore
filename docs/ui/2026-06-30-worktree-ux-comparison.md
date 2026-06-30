# Worktree UI/UX Comparison — nightcore vs automaker vs Aperant

**Date:** 2026-06-30
**Agent:** kirei-ui (parallel kirei-chain alongside kirei-arch, which owns backend/lifecycle)
**Lens:** UI/UX only — how worktrees are made visible, created, inspected, merged, discarded; status indicators; diff/review; empty/loading/error states; discoverability; information hierarchy; friction.
**Scope:** nightcore `apps/web` (React + Tailwind, folder-per-component) · automaker `apps/ui` (React + Tailwind + shadcn, Electron) · Aperant `apps/desktop/src/renderer` (React + Tailwind + shadcn + react-i18next, Electron)

---

## Summary

nightcore has the **cleanest, best-integrated, most accessible** worktree surface (worktree-as-board-filter tabs with roving-tabindex a11y), but it is by far the **thinnest**: there is **no diff view, no merge preview, no merge/discard confirmation, and no per-file/line stats anywhere**. Merge is a single gated button with no "what am I about to integrate" affordance, and the switcher is **hidden entirely when ≤1 worktree exists** — so for the common single-task case worktree state is invisible.

**Aperant has the best overall worktree UX** and is the primary model to adopt from: a clean workspace **state machine** (loading → staged → worktree → none), a **pre-merge preview with conflict severity**, a **real-time merge progress overlay with stall detection**, a **dedicated Worktrees page** with polished empty/loading/error/bulk states, and consistently safe, copy-rich confirmation dialogs (i18n throughout). **Automaker wins on the create flow and raw power** — a persistent always-visible worktree bar with inline dirty/conflict/PR/dev-server/test indicators, a true **line-level CodeMirror diff with staging**, and the friendliest **git-error-to-human-message** mapping — but its density is overwhelming (a 1,654-line panel + 1,463-line actions dropdown) and a poor fit for nightcore's minimal aesthetic.

Recommended verdict: **Aperant #1** (clarity, safety, feedback, hierarchy) · **Automaker #2** (power, but high cognitive load) · **nightcore #3** (clean but missing the core review/merge affordances).

---

## 1. How a worktree is REPRESENTED visually

### nightcore — worktree-as-board-filter tab (minimal)
- A segment bar above the board: a "Main" tab + one tab per live worktree. Selecting a tab filters the board to that worktree's tasks. `apps/web/src/components/board/WorktreeSwitcher/WorktreeSwitcher.tsx:11-36`.
- Per-tab anatomy: branch label, task-count chip, pulsing running-count, dirty dot (`●`), ahead-of-base (`↑N`). `WorktreeSwitcher/WorktreeSwitcher.parts.tsx:44-73`.
- On the card itself: a branch chip / "main" chip / "merge conflict" chip, surfaced only once the task is "settled". `apps/web/src/components/board/TaskCard/TaskCard.tsx:169-223`.
- **Strength:** tight integration — the worktree *is* the board filter; excellent a11y (`role="tablist"`, roving tabindex, `aria-selected`). **Gap:** no path, no behind-count, no file/line counts, no PR/dev-server context.

### automaker — persistent, dense status-bar tab (power-user)
- A horizontal worktree bar (the `WorktreePanel`) is always present above the board and is itself a drag-drop target for feature cards. `apps/ui/src/components/views/board-view/worktree-panel/components/worktree-tab.tsx:315-322` (droppable), `…/worktree-panel.tsx`.
- The tab packs a *lot* inline: branch name, card-count chip, uncommitted-changes badge **with file count + tooltip** (`worktree-tab.tsx:349-371`), conflict badge **with conflict-type + file-count tooltip** (`:372-394`), a clickable **PR badge** colored by state that opens the PR (`:275-312`), a dev-server "globe" launch button (`:489-511`), an auto-mode pulse (`:513-529`), and a full actions dropdown (`:531-600`).
- Shared, consistent badge styling lives in one util: `worktree-panel/components/worktree-indicator-utils.ts:29-94` (PR state, changes, conflict, test status).
- **Strength:** everything visible at a glance, no drill-in needed. **Gap:** very high cognitive load; the tab + dropdown are enormous.

### Aperant — task-centric workspace card (clear)
- Worktree state lives inside the task-detail **review** flow as a `WorkspaceStatus` card, plus a separate top-level **Worktrees** page listing all worktrees. `…/task-detail/task-review/WorkspaceStatus.tsx`, `…/components/Worktrees.tsx`.
- The workspace card shows a compact stats row (files / commits / +adds / −dels), a `branch → target` arrow, the worktree path, and "Open in IDE / Open in Terminal" buttons. `WorkspaceStatus.tsx:303-361`.
- The Worktrees page groups **Task Worktrees** vs **Terminal Worktrees** as cards with branch, task title, orphaned label, and spec-name badge. `Worktrees.tsx:582-619`.
- **Strength:** clear hierarchy, stats-forward, never overwhelming. **Gap:** worktree state isn't surfaced on the kanban card itself (only in detail/dedicated page).

---

## 2. The CREATE flow

- **nightcore:** no explicit "create worktree" action — a worktree is implied by choosing **Worktree** run-mode on the task (`WorkModePicker.tsx:9-47`, a segmented Main/Worktree radio with a one-line hint). Lowest friction, but also no control over branch name or base branch, and no feedback that a worktree was allocated.
- **automaker — best create flow.** `dialogs/create-worktree-dialog.tsx`: branch-name input with git-name validation (`:316-341`), autofocus + Enter-to-submit (`:404-408,437`), a **collapsible Base Branch section** with a **local/remote source picker** and branch autocomplete (`:441-566`), a "remote — will fetch latest" hint (`:552-557`), a Refresh control, inline examples, and **success toasts that report sync outcome** (diverged / local-copy / synced) (`:366-386`). Git errors are mapped to friendly titles+descriptions via `parseWorktreeError` (`:50-108`).
- **Aperant:** worktrees are created automatically when a task builds (the empty state literally explains this — `Worktrees.tsx:565-576`), plus an explicit `terminal/CreateWorktreeDialog.tsx` for terminal worktrees. Lower-friction than automaker, more guided than nightcore.

---

## 3. STATUS surfacing (clean/dirty, ahead/behind, conflicts, counts, live updates)

| Signal | nightcore | automaker | Aperant |
|---|---|---|---|
| Dirty / uncommitted | dot `●` (no count) `parts.tsx:60-64` | badge **+ file count + tooltip** `worktree-tab.tsx:349-371` | warning block + count `WorkspaceStatus.tsx:374-387` |
| Ahead of base | `↑N` `parts.tsx:66-73` | in actions dropdown (`aheadCount`) | `commitsBehind`/diverged messaging `WorkspaceStatus.tsx:437-465` |
| Behind base | ✗ none | yes (`behindCount`) | yes (branch-behind scenario) |
| Conflicts | "merge conflict" chip on card `TaskCard.tsx:204-209` | typed badge + file count `worktree-tab.tsx:372-394` | severity-ranked preview `MergePreviewSummary.tsx:25-60` |
| File / line counts | ✗ none | full diff stats | files/commits/+/− `WorkspaceStatus.tsx:303-321` |
| PR state | ✗ none | clickable colored badge `worktree-tab.tsx:275-312` | dedicated CreatePR flow |
| Running / activity | pulsing count `parts.tsx:50-58` | spinner + auto-mode pulse | merge progress overlay |
| Live updates | debounced refetch on `nc:task` `AppShell/hooks/useWorktrees.hooks.ts:38-49` | query hooks | query hooks + merge progress events |

nightcore's live-update plumbing (monotonic seq, trailing-debounce, reset-to-Main on project switch) is **solid** — it just surfaces fewer signals than the others.

---

## 4. DIFF / review experience

- **nightcore — none.** Confirmed: no diff viewer, no changed-files list, no +/- stats anywhere in `apps/web` (grep for `additions|deletions|filesChanged|changedFiles|FileCode` returns nothing in components). The user cannot see *what changed* before merging. **This is the single biggest gap.**
- **automaker — best/deepest.** A real **line-level diff** via CodeMirror, with **per-file staging/unstaging**, file-status icons + colored badges. `components/ui/git-diff-panel.tsx:20,29-77` (CodeMirrorDiffView, `enableStaging`), opened from `dialogs/view-worktree-changes-dialog.tsx:59-67`.
- **Aperant — lighter but clear.** A **changed-files list** dialog with per-file status color, `+adds`/`−dels` per file, and a summary line. `task-detail/task-review/DiffViewDialog.tsx:42-77`. (File-list granularity, not line-level — but enough to review scope.)

---

## 5. MERGE / integrate / discard affordances

- **nightcore — thinnest.** Merge is a single button, gated on `verified + passing gauntlet`, with a tooltip when disabled and an inline spinner; **no confirmation dialog, no preview, no target-branch choice.** `TaskDetail.tsx:253-296`, `TaskCard.tsx:298-345`. Discard = generic task "Delete" (no worktree-specific warning). Cleanup is a global setting only: `SettingsView/SettingsView.tsx:623-633` ("Delete worktree on complete").
- **automaker — safe + explicit.** `dialogs/merge-worktree-dialog.tsx`: target-branch autocomplete, a **dirty-state guard that blocks merge until committed/discarded** (`:306-314,350`), an optional "delete worktree and branch after integrating" checkbox with a destructive warning (`:319-342`), and on conflict it **transitions to a resolution screen offering "Resolve with AI" or "Resolve Manually"** (`:186-269`). Delete dialog warns about affected features and lost uncommitted changes (`dialogs/delete-worktree-dialog.tsx:104-174`). Discard shows a per-file status preview (`dialogs/discard-worktree-changes-dialog.tsx:48-103`). All actions report via `sonner` toasts.
- **Aperant — best feedback + safety.** Merge runs through a **pre-merge preview** (`MergePreviewSummary.tsx:20-111`: no-conflict / branch-diverged / N-conflicts, with severity + auto-mergeable/AI-resolved/manual-review stats) and a **real-time `MergeProgressOverlay`** (`MergeProgressOverlay.tsx:39-78`: progress bar, stage labels, conflict counter, expandable log, **30s stall detection**). Discard confirmation shows inline file/line stats and states the consequence ("moved back to Planning") `DiscardDialog.tsx:42-92`. Cleanup-on-done is a confirmation dialog with an **error→retry state** `WorktreeCleanupDialog.tsx:38-111`. Handles **already-merged / superseded** edge cases gracefully `WorkspaceStatus.tsx:397-435`.

---

## 6. Discoverability & information hierarchy

- **nightcore:** worktrees are discoverable only via the switcher tabs, **which render nothing when `tabs.length <= 1`** (`WorktreeSwitcher.tsx:14`). So with a single worktree (the common case) there is *no* worktree UI at all; state hides until you have 2+. Settings has a "Git worktrees" page (`SettingsView.tsx:603-636`) but it's config, not live state.
- **automaker:** always-on worktree bar, with a per-project "Worktree Bar" visibility toggle (`board-view/board-header.tsx:199-216`). Maximum discoverability; the trade-off is density.
- **Aperant:** a first-class **Worktrees** nav destination (`Worktrees.tsx`) plus the in-task review card. Two clear, complementary entry points; strong hierarchy (sectioned Task vs Terminal worktrees).

---

## 7. Empty / loading / error states

- **nightcore:** board columns have empty text (`Board.tsx:225`), but there is **no worktree-specific empty/loading/error UI** — the switcher simply renders nothing.
- **automaker:** create-dialog has inline error blocks + branch-fetch error fallback (`create-worktree-dialog.tsx:488-493,568-578`); panel has its own error boundary (`board-view/board-error-boundary.tsx`).
- **Aperant — best.** The Worktrees page has a polished **empty state** (icon-in-circle + explanatory copy, `Worktrees.tsx:565-576`), a **loading spinner** (`:557-562`), an **error block** (`:544-555`), and the review flow has explicit `LoadingMessage` / `NoWorkspaceMessage` states (`TaskReview.tsx:112-159`).

---

## Recommended UI/UX patterns for nightcore to ADOPT (ranked by impact)

1. **Pre-merge preview before the Merge button fires** — *Aperant, best.* `MergePreviewSummary.tsx:20-111` + `WorkspaceStatus.tsx:437-512`. Show "Ready to merge / N conflicts / branch diverged" with file count + conflict severity *before* committing to the merge. nightcore today merges blind (`TaskDetail.tsx:253-296`). Highest-value gap to close.

2. **A changed-files view for the worktree** — *Aperant for the lighter version (`DiffViewDialog.tsx:42-77`: file list + status colors + +/- counts), automaker for the deep version (`git-diff-panel.tsx` CodeMirror + staging).* Start with Aperant's file-list (cheap, high clarity); graduate to line-level later. nightcore has zero diff UI today.

3. **A real-time merge progress overlay with stall detection** — *Aperant, best.* `MergeProgressOverlay.tsx:39-78`. Replace nightcore's silent spinner with stage labels + progress + an expandable log so a long/AI-assisted merge is observable. Pairs with nightcore's existing event stream.

4. **Safe, copy-rich discard/cleanup confirmation with consequence + stats** — *Aperant, best.* `DiscardDialog.tsx:42-92` and `WorktreeCleanupDialog.tsx:38-111` (note the error→retry state). nightcore's discard is an undifferentiated task "Delete" with no worktree warning.

5. **Always show worktree status even for a single worktree** — *Aperant/automaker.* Remove/relax nightcore's `tabs.length <= 1` early-return (`WorktreeSwitcher.tsx:14`) so a lone worktree still shows dirty/ahead/diff affordances. Optionally a per-project visibility toggle like automaker's "Worktree Bar" (`board-header.tsx:199-216`).

6. **Richer inline status badges with counts + tooltips** — *automaker, best.* `worktree-tab.tsx:349-394` + shared `worktree-indicator-utils.ts:29-94`. Add a **dirty file-count** (not just `●`), a **behind-base** count, and a conflict file-count tooltip to nightcore's tab badges. Centralize badge styling in one util for consistency.

7. **A dedicated Worktrees destination with polished empty/loading/error/bulk states** — *Aperant, best.* `Worktrees.tsx:514-576` (tri-state select-all, bulk delete with count, empty/loading/error). Gives nightcore a home for orphaned-worktree cleanup and cross-task worktree management beyond the board filter.

8. **Friendly git-error → human-message mapping + outcome toasts** — *automaker, best.* `create-worktree-dialog.tsx:50-108` (`parseWorktreeError`) and sync-result toasts (`:366-386`). nightcore already has a `Toast` system (`components/ui/Toast/`) — wire merge/commit/cleanup outcomes through it with actionable copy.

9. **Conflict-resolution choice on merge failure (AI vs manual)** — *automaker `merge-worktree-dialog.tsx:186-269` / Aperant AI-resolve `MergePreviewSummary.tsx:73-89`.* When a merge conflicts, offer a clear next step instead of a dead-end error. (Backend-heavy — coordinate with kirei-arch.)

10. **Keep nightcore's strengths.** The worktree-as-board-filter model, roving-tabindex a11y (`WorktreeSwitcher.parts.tsx:21-25`), and debounced live refetch (`useWorktrees.hooks.ts:25-49`) are genuinely better than the siblings' — adopt the above *without* importing automaker's overwhelming density (its 1,654-line panel / 1,463-line dropdown are an anti-pattern for nightcore's aesthetic).

---

## Notes flagged for kirei-arch (backend/lifecycle — not duplicated here)
- A merge preview, changed-files view, and progress overlay all need backend data sources nightcore lacks today: diff/stat extraction, conflict pre-detection, and merge-progress events. `bridge.ts` currently exposes only `listWorktrees`/`mergeTask`/`commit` (`apps/web/src/lib/bridge.ts:531-581`) with no diff/preview command.
- AI conflict resolution (patterns 9) is primarily a lifecycle/engine concern.
