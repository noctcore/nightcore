# UI/UX Audit — Worktree / Branch Surfaces: Nightcore vs Automaker

**Date:** 2026-07-05
**Agent:** kirei-ui (parallel kirei-chain; lens = UI components, UX flows, discoverability, interaction design)
**Nightcore stack:** React + Tauri (WKWebView), strict folder-per-component, custom ESLint plugin, in-house `ui/` primitives (no shadcn). Worktree surfaces under `apps/web/src/components/{worktree,board}`.
**Automaker stack:** Electron + React + TanStack Router, shadcn/ui (`@/components/ui/dropdown-menu` with `Sub`/`SubTrigger`/`SubContent`), Zustand `app-store`. Worktree surfaces under `apps/ui/src/components/views/board-view/worktree-panel`.
**Scope:** the branch/worktree dropdown + diff affordances in both apps, and the three flows the user wants added to Nightcore.

## Summary
Automaker's worktree UX is an order of magnitude richer because it puts a **single, persistent, per-worktree action menu on the board itself** (`worktree-actions-dropdown.tsx`, ~1,460 lines, ~30 actions) built on shadcn `DropdownMenu` with nested submenus, split-buttons, and inline per-item state badges (ahead/behind, PR state, dirty count, tracking remote, test pass/fail). Nightcore's worktree management is functionally competent (diff, merge-preview, discard, PR lifecycle) but **scattered and low-discoverability**: it lives in a *separate* `Worktrees` nav destination (`WorktreeManager`, 3 actions per row), the board's `WorktreeSwitcher` is filter-only (not a menu, not a drop target), and the `TaskCard`/`TaskDetail` carry **no worktree actions at all** beyond commit/merge. All three requested flows are close to reachable: **3a already has a backend command** (`discardWorktree` = "safe cleanup, distinct from deleting the task") that is simply mis-placed and mis-labelled; **3c is half-built** (run-mode is editable pre-run in `SessionCard`); **3b is unbuilt** and needs a backend reassign (flagged to kirei-arch).

---

## Part 1 — Automaker's branch/worktree dropdown (inventory)

### 1.1 Where it lives & how it's composed
Worktrees render as a **persistent horizontal tab strip on the board** (`worktree-panel/worktree-panel.tsx`). Each tab (`worktree-panel/components/worktree-tab.tsx`) is a 3-part attached control:

```
[ branch button + inline status badges ] [ BranchSwitchDropdown (main only) ] [ WorktreeActionsDropdown ⋯ ]
```

- At **3+ worktrees** the strip collapses into a single `WorktreeDropdown` (`worktree-panel/components/worktree-dropdown.tsx:179`) whose trigger shows the selected worktree with the full badge cluster, and whose body groups **Main Branch** + **Worktrees (n)**.
- Each `WorktreeTab` is a **drop target** (`worktree-tab.tsx:220-229`, `useDroppable` id `worktree-drop-<branch>`), so a feature card can be **dragged onto a worktree** (ring highlight on `isOver`, line 318-321).

### 1.2 `WorktreeActionsDropdown` — every action (file: `worktree-panel/components/worktree-actions-dropdown.tsx`)
Trigger = `MoreHorizontal` icon button (`:413-427`). Menu content (`:428`) in order:

| Section | Action(s) | Lines | Notes |
|---|---|---|---|
| Conflict banner | Abort / Continue op, **Resolve with AI** | 429-500 | Only when `hasConflicts`; header shows conflict type + file-count badge |
| Git-status | "Checking git status…" / "Not a git repository" / "no commits" warnings | 501-520 | Gates every git op via `isGitOpsAvailable` |
| Auto Mode | Start / Stop Auto Mode | 521-539 | Pulsing green dot when running |
| Dev server | Open in Browser, **Start/Stop Dev Server (split → View Dev Server Logs)** | 540-609 | Live label with `:port` |
| Test runner | Run Tests / Stop Tests / View Test Logs / **View Last Test Results (passed·failed badge)** | 610-668 | Only when `hasTestCommand` |
| Open in editor | **split**: default editor + submenu (other editors + **Copy Path**) | 669-716 | Icons per editor via `getEditorIcon` |
| Open in terminal | **split**: default terminal + submenu (integrated **New Tab / Split**, external terminals w/ `(default)`) | 717-787 | |
| Scripts | Re-run Init Script + terminal quick scripts + Edit Commands & Scripts | 788-838 | Submenu |
| **Pull** | split (per-remote submenu w/ **Set as Tracking Branch**); badge `N behind` / `on <remote>` | 840-927 | |
| **Push** | split (per-remote); badges `local only` (CloudOff), `N ahead`, tracking-remote name | 928-1075 | Disabled when nothing to push |
| Sync | pull+push, per-remote | 1076-1141 | |
| Merge & Rebase | opens resolve/rebase dialog (purple) | 1142-1157 | |
| **Integrate Branch** | merge worktree → base (green, non-main) | 1158-1178 | |
| View Commits | **split → Cherry Pick** | 1179-1245 | |
| View Changes | **split → Create Stash / View Stashes** | 1246-1308 | |
| Commit Changes | when `hasChanges` | 1309-1326 | |
| Create PR / PR info | Create PR, or PR chip (state badge) **split → Manage PR Comments / Address PR Comments / Change PR #** | 1327-1398 | |
| Discard Changes | destructive, when `hasChanges` | 1400-1420 | |
| **Swap Worktree** | submenu of other worktrees (pinned ✓) → swaps this slot to another branch | 1421-1450 | **directly relevant to flow 3b** |
| **Delete Worktree** | destructive, non-main | 1451-1459 | worktree-only delete; card/task untouched |

### 1.3 How state is presented
- **Trigger badge cluster** (`worktree-dropdown.tsx:309-444`): running spinner, branch icon+truncated name (tooltip when truncated), **card-count badge**, **uncommitted-changes badge** (`CircleDot` + `changedFilesCount`), dev-server `Globe`, dev-server-starting spinner, test running/last-result `FlaskConical`, **auto-mode pulsing dot**, **conflict badge** (`AlertTriangle` + type), **PR badge** (`#num` + state color), chevron.
- **ahead/behind** are shown *inline on the Pull/Push items* as `N behind` / `N ahead` pills (`:859-868`, `:970-990`), not just in the trigger.
- `WorktreeTab` (`worktree-tab.tsx`) repeats changed-files + conflict badges with tooltips, and a **clickable PR badge** (`role="button" tabIndex=0` + keydown, `:275-311`) that opens the PR.

### 1.4 Interaction patterns worth stealing
- **Split-button rows** = `DropdownMenuItem flex-1 rounded-r-none` + `DropdownMenuSubTrigger` chevron: primary action on click, variants via chevron. Used ~10×.
- **Nested submenus** 2-3 deep (`DropdownMenuSub`).
- **`TooltipWrapper`** on every git-gated item explains *why* it's disabled (`gitOpsDisabledReason`).
- **Drag card → worktree tab** to assign work.
- **Create-time work-mode picker** (`shared/work-mode-selector.tsx`): 3-card grid — *Current Branch / Auto Worktree / Custom Branch* — with a `BranchAutocomplete` (annotated by `branchCardCounts`) for the custom branch. `disabled` after work starts, with the explainer "Work mode cannot be changed after work has started" (`:156-160`).
- **Branch switch dropdown** (`branch-switch-dropdown.tsx`): search input + Local/Remote groups + "Create New Branch…".

---

## Part 2 — Nightcore's current worktree surfaces (inventory + shortfalls)

### 2.1 Reachability map (what's where)
| Surface | File | Worktree-related affordances |
|---|---|---|
| **Worktrees view** (nav dest, hotkey `W`) | `worktree/WorktreeManager/WorktreeManager.parts.tsx:81-107` | Per row: **Diff**, **Merge**, **Discard** + static `PR #n` link-out. Actions **disabled when `primaryTaskId === null`** (`:50`). |
| WorktreeManager row status | `WorktreeManager.parts.tsx:16-26`, `.types.ts` | chips: `changed` / `↑ahead` / `↓behind` / `diverged`. No live per-row polling by design. |
| **Board filter bar** | `board/WorktreeSwitcher/WorktreeSwitcher.tsx` + `.parts.tsx:44-93` | Tabs (Main + per-worktree) with task-count, running dot, dirty `●N`, `↑N`, `↓N`. **Filter only — no actions, not a drop target**, hidden when ≤1 tab. |
| **Task card** | `board/TaskCard/TaskCard.tsx` | Inline status buttons only (Run/Edit, Logs/Cancel, Approve/Refine, Commit/Merge, Retry, + Delete trash `:397-404`). Branch chip `:191`, main chip `:196`, conflict chip `:217`. **No worktree menu, no diff, no cleanup.** |
| **Task detail drawer** | `board/TaskDetail/TaskDetail.tsx` | Footer: Commit / Merge / Create-PR / PR link / Delete (`:430-503`); `PrStatusCard` (push-updates/finalize/pull-base-ff), `PrReviewComments` (address comments), gauntlet, ReviewPanel. **No diff view, no discard-worktree, no editor/terminal, no branch switch.** |
| Session config | `board/SessionCard/SessionCard.tsx:116-183` | `WorkModePicker` (main↔worktree) editable **pre-run only** (`kindEditable`); read-only pills post-run (`:187-218`). |
| Create dialog | `board/NewTaskForm/NewTaskForm.tsx:125-153` | `WorkModePicker` + `BranchPicker` (branch) + `BranchPicker` (base) when worktree. |
| Diff / merge dialogs | `worktree/{DiffViewDialog,MergePreviewDialog,DiscardDialog}` | Solid: merge-preview shows status banner + branch→base + ahead/behind/file stats + conflict files (`MergePreviewDialog.tsx:5-13`). |

### 2.2 UI-primitive gap
Nightcore's only menu primitive is **`ui/Menu.tsx`** — a **flat** menu: items are `{ label, icon, onClick, destructive }` (`:14-20`), **no submenus, no split-buttons, no per-item state badges**. Automaker's power comes entirely from shadcn `DropdownMenu` submenu composition. Established Nightcore kebab convention (trigger = `IconButton`) already exists in `ProjectCard`, `InsightView`, `ScorecardView`, `HarnessView`, `ReviewSection` — but **`TaskCard` has no kebab**.

### 2.3 Where the UX falls short vs Automaker
- **Discoverability.** Every worktree action in Nightcore beyond commit/merge requires leaving the board for the `Worktrees` nav destination. Automaker keeps them one click away on a board-resident tab. Viewing a worktree diff or discarding a worktree is **impossible from the card or the detail drawer** — the two places a user actually works.
- **Clicks / context.** Nightcore "view this task's diff" = navigate to Worktrees (1) → visually locate the row → Diff (1), and the row is keyed on the *worktree's primary task*, not the task you had selected. Automaker = ⋯ (1) → View Changes (1), contextual to the worktree.
- **Missing actions** (present in Automaker, absent in Nightcore): open-in-editor, open-in-terminal, copy path, pull/push/sync (Nightcore only has PR-scoped push-updates + base pull-ff), stash, cherry-pick, view-commits, switch-branch, create-branch, run-tests, dev-server, run-scripts, **swap worktree**, **drag card → worktree**, **discard-worktree from the card/detail**.
- **State surfacing.** Nightcore surfaces ahead/behind/dirty only on the *filter tabs* and *manager rows*; the card shows just a branch chip. Automaker threads the same state into the action menu itself (badges on Pull/Push), so the user sees *and acts* in one place.
- **Copy.** `DiscardDialog` ("This permanently removes the worktree … and deletes its branch. Uncommitted changes are lost.", `DiscardDialog.tsx:38-42`) never tells the user the **task survives** — so "clean up worktree but keep the task" reads as data loss.

---

## Part 3 — The three requested flows (state + concrete component designs)

### 3a. "Clean up worktree but keep the task" — CAPABILITY EXISTS, mis-placed & mis-labelled
- **Backend already does this.** `discardWorktree(id)` is documented "safe cleanup, **distinct from deleting the task**" (`lib/bridge/commands.ts:533-538`), already wired to the manager row's **Discard** (`WorktreeManager.parts.tsx:98-105` → `WorktreeView.hooks.ts:162-179`). The task stays on the board. This is a **placement + copy + gating** problem, not a capability gap.
- **Design:**
  1. **Primary — TaskDetail footer.** For a `done`/verified worktree task (`task.runMode === 'worktree'` and a live worktree exists), add a secondary **"Clean up worktree"** button beside Delete (`TaskDetail.tsx` done-column footer, `:430-503`). Calls the same `discardWorktree` path.
  2. **Secondary — TaskCard kebab.** Add a `board/TaskActionsMenu/` component using the existing `ui/Menu` (matches the `ProjectCard` kebab convention): *View diff · Clean up worktree · Delete task*. Slots next to the Delete trash icon (`TaskCard.tsx:397-404`).
  3. **Copy fix — reframe `DiscardDialog`.** Retitle to **"Clean up worktree"**; body: "The task stays on the board in **Verified** — only its `nc/…` branch and worktree are removed." Keep the uncommitted-file warning (`DiscardDialog.tsx:43-48`). Optionally guard: offer clean-up freely when merged/verified; warn when the branch has unmerged commits.
  4. Keep the WorktreeManager row action; just re-label "Discard" → "Clean up" for consistency.
- **Impeccable:** `impeccable:clarify` (dialog copy), `impeccable:harden` (guard the unmerged-commits case).

### 3b. "Push a task to a specific already-running worktree" — UNBUILT (UI + backend gap)
- **State:** `NewTaskForm` only lets you *name* a branch (mints `nc/<taskId>` or adopts a branch); `TaskPatch` **cannot set `branch`** (`generated/TaskPatch.ts` has `runMode` but no `branch`; `Task.ts:195` — "NOT settable via `TaskPatch`"). So no retarget after creation and no "pick a live worktree." Automaker solves the same need three ways: **Swap Worktree** submenu (`worktree-actions-dropdown.tsx:1421-1450`), **drag card → worktree tab**, and the **custom-branch** work-mode.
- **Design (UI lens; needs a backend `reassign`/target-branch command — flagged to kirei-arch):**
  1. **Create-time (cheapest).** In `NewTaskForm`, when `runMode === 'worktree'`, enrich the branch `BranchPicker` to annotate branches that already have a **live worktree** (tag + task-count, mirroring Automaker's `branchCardCounts`), and add an **"Existing worktrees"** group above "Other branches." Picking one targets that worktree.
  2. **Assign-by-drag.** Make the board `WorktreeSwitcher` tabs **drop targets** (port Automaker's `useDroppable('worktree-drop-<branch>')`, `worktree-tab.tsx:220-229`): drag a backlog card onto a worktree tab to assign+run it there. Nightcore already has `@dnd-kit` for column drops (`BoardDnd`), so this is additive.
  3. **Pre-run target picker.** In `SessionCard`'s run-mode row (`SessionCard.tsx:140-145`), when worktree mode is selected, add a compact **"Target: nc/… ▾"** control listing existing worktrees + "New worktree."
- **Impeccable:** `impeccable:arrange` (picker grouping), `polish-ui` (drag affordance parity).

### 3c. "Move a task back to the main board" — HALF-BUILT (pre-run only)
- **State:** run-mode is editable **pre-run** via `SessionCard`'s `WorkModePicker` (`SessionCard.tsx:140-145`, `TaskPatch.runMode` supported, `handleChangeRunMode` = `makeFieldUpdater('runMode')` in `AppShell.hooks.ts:538`). Gated by `kindEditable` — **not possible once the task has run**. No affordance from the card or switcher.
- **Design:**
  1. **Pre-run already works** — improve discoverability by echoing the current run mode as a chip on the card that deep-links to the SessionCard picker.
  2. **Post-run "Run on main instead."** In the TaskCard kebab (3a) / TaskDetail, for a worktree task that is `backlog`/`ready`/`failed`/`interrupted` (not mid-run), add **"Run on main instead"**: flips `runMode → 'main'` via `updateTask`, and if a worktree exists, chains a `discardWorktree` confirm ("Removes the `nc/…` worktree; the task re-runs against the project root"). Gate off while `in_progress`/`verifying`.
- **Impeccable:** `impeccable:clarify` (confirm copy), `impeccable:harden` (guard mid-run).

---

## Recommended fix order
1. **3a placement + copy** — highest value, lowest cost (backend already exists). TaskDetail "Clean up worktree" button + `DiscardDialog` re-label.
2. **TaskCard kebab** (`board/TaskActionsMenu/` on `ui/Menu`) — unlocks 3a/3c per-card and is the anchor for future worktree actions.
3. **3c "Run on main instead"** — one `updateTask` + optional discard confirm.
4. **Bring diff to the card/detail** — reuse `DiffViewDialog` from the TaskDetail/kebab so "see this task's changes" doesn't require the Worktrees nav trip.
5. **3b create-time picker** enrichment, then **drag card → worktree** (needs backend reassign).
6. **Optional richer action menu** — extend `ui/Menu` (sections/submenus/state badges) or add `worktree/WorktreeRowMenu` to approach Automaker's per-worktree menu (open-in-editor/terminal, pull/push, stash, view-commits).

## Cross-lens notes (NOT my lens — for kirei-arch / kirei)
- **Backend gaps** blocking 3b/3c-post-run: `TaskPatch` can't set `branch`; no reassign-to-worktree command; no post-run run-mode change semantics (what happens to the old worktree). (kirei-arch)
- **Missing backend commands** behind Automaker parity: open-in-editor/terminal, per-remote pull/push/sync, stash, cherry-pick, list-commits. (kirei-arch)
- Whether "drag card → worktree" implies a shared/multi-task-per-worktree model (`WorktreeInfo.taskIds` is already a `Vec` "so a later shared-board model fits" — `generated/WorktreeInfo.ts:16-21`). (kirei / kirei-arch)
