# Research: Worktree/Branch Capability Gap — Automaker vs Nightcore

**Date:** 2026-07-05
**Agent:** kirei (general/product lens)
**Status:** complete
**Companion investigations:** kirei-arch (lifecycle coupling + domain model), kirei-ui (dropdown/menu UX)

## Problem

The user finds Automaker's branch/worktree dropdown far more powerful than
Nightcore's, and named three specific missing capabilities in Nightcore:

1. **cleanup-worktree-preserve-task** — mark a worktree'd task done, delete its
   worktree, but keep the task on the board (Verified). Today the only cleanup
   path they can find is deleting the task, which destroys the task record too.
2. **assign/push a task to an existing running worktree** — reuse another
   worktree's branch/checkout instead of always minting a fresh per-task one.
3. **move a worktree-mode task back to the main board (repo-root mode)**.

This document is the product-level capability inventory: a side-by-side matrix,
a root-cause per gap with file:line evidence, adjacent capabilities Automaker
has that the user did not name, and a prioritized recommendation list.

## Root Cause — one architectural fork drives all three gaps

The two apps model "worktree ↔ task" fundamentally differently:

- **Nightcore: worktree is TASK-ID-KEYED and 1:1 with a task.** The dir is always
  `<project>/.nightcore/worktrees/<taskId>` and the branch defaults to
  `nc/<taskId>`. Even a custom picker branch still allocates a dir keyed by task
  id: `worktree::allocate_branch(&project_path, task_id, &branch, &base)` writes to
  `worktree_path(project_path, task_id)`
  (`apps/desktop/src-tauri/src/orchestration/coordinator/cwd.rs:72,77`;
  `apps/desktop/src-tauri/src/worktree/lifecycle.rs:17,63-69`). Two tasks can
  never share a checkout, and a task's identity is welded to its worktree dir.

- **Automaker: worktree is BRANCH-KEYED and first-class, independent of the
  feature.** The dir is `.worktrees/<sanitizedBranchName>`
  (`apps/server/src/routes/worktree/routes/create.ts:175-177`) and create even
  *reuses* an existing worktree for a branch instead of erroring
  (`create.ts:46-92,152-172`). A "feature" (Automaker's task) is a lightweight
  record carrying a **mutable `branchName` pointer**:
  `branchName?: string | null; // undefined/null = use current worktree (main)`
  (`libs/types/src/feature.ts:96`).

Because Automaker features point at a branch by a mutable field, all three of the
user's operations are just "re-point `branchName`":
- delete worktree → set every affected feature's `branchName = null` (kept, moved
  to main) — `apps/server/src/routes/worktree/routes/delete.ts:147-189`.
- assign to an existing worktree → drag the card onto that worktree tab, sets
  `branchName = targetBranch` — `apps/ui/.../hooks/use-board-drag-drop.ts:127-172`.
- move back to main → drag onto the Main tab, sets `branchName = undefined`
  (`use-board-drag-drop.ts:151`).

In Nightcore there is **no mutable task→worktree pointer to re-point.** The branch
is chosen once at create (`NewTaskForm.hooks.ts:165-166`) and the worktree dir is
derived from the immutable task id, so none of the three operations has a seam.

## Evidence

### Gap 1 — cleanup-worktree-preserve-task

**This one MOSTLY EXISTS in Nightcore's backend but is disconnected from the board.**

- `discard_worktree` already does exactly what the user wants at the command layer:
  removes the worktree dir + deletes its branch, clears `conflict`/`error`, and
  **leaves the task record and its status untouched** (a Done/verified card stays
  Done/verified). It refuses while the task is running.
  `apps/desktop/src-tauri/src/commands/worktree.rs:130-164` (running-guard at
  `:146-152`; the mutate only clears `conflict`/`error` at `:158-161` — status is
  never changed).
- It is registered (`lib.rs:266`) and bridged (`apps/web/src/lib/bridge/commands.ts:536`).
- **But it is only surfaced in the standalone "Worktrees" view / WorktreeManager,
  a separate `AppView` from the board** (`AppShell.tsx:79` nav item `worktrees`;
  `:283-285` renders `WorktreeView`). Callers: `WorktreeView.hooks.ts:166` and
  `WorktreeManager.parts.tsx:101`. The board's task drawer never calls it —
  `TaskDetail.hooks.ts` has Merge / Create PR / commit affordances but **no
  discard** (grep of that file shows no `discard`).
- Meanwhile `delete_task` is the destructive path the user found: it removes the
  task JSON *and* the worktree+branch (`commands/task.rs:186-196`,
  `cleanup_task_worktree` at `:300-323`).

Net: the capability is 80% built. The gap is that "discard worktree, keep the
Verified card" is not offered where the user looks for it (the board card /
TaskDetail); it lives in a separate Worktrees destination they apparently didn't
connect to their Done cards. **This is primarily a UI-surfacing gap (kirei-ui
lens), not a missing backend command.** One product nuance: after discard the
task keeps `run_mode = worktree` and a stale `branch` chip, so a "cleaned up"
Verified card still reads as a worktree task with no worktree — see Gap 3.

### Gap 2 — assign/push a task into an existing running worktree

**Genuinely impossible today; no command and no data model for it.**

- The run-cwd resolver keys the worktree dir by task id unconditionally
  (`cwd.rs:60-81`): custom-branch → `allocate_branch(project, task_id, branch, base)`
  which still writes `worktree_path(project, task_id)`; default → `allocate(project,
  task_id)`. There is no code path that points task B at task A's checkout.
- Even if two tasks picked the same branch name, git refuses to check out one
  branch in two worktrees ("already checked out"), so branch-sharing is blocked at
  the git layer too — the model assumes disjoint `nc/<taskId>` branches.
- `TaskPatch` (the only post-create mutation contract) has `run_mode` but **no
  `branch` / `base_branch` field** (`store/task/patch.rs:36-70`) — you cannot
  re-target a task's branch after create through the normal update path.
- Automaker, by contrast: `create` reuses an existing branch's worktree
  (`create.ts:152-172`), and the UI assigns a card to a running worktree by drag
  (`use-board-drag-drop.ts:136-172`) with a running-task guard (`:138`).

### Gap 3 — move a worktree-mode task back to main/repo-root

**Backend can flip the flag, but there is no first-class "move to main" operation,
no UI affordance, and no worktree cleanup — so it is effectively missing.**

- `TaskPatch.run_mode` exists and `apply` sets it (`patch.rs:56-58,91-93`), so
  `update_task { runMode: 'main' }` would technically flip the mode. BUT:
  - The run-mode picker is only rendered in the create form (`NewTaskForm.tsx:127`,
    `WorkModePicker`); there is no post-run "switch this task to main" control on
    the board or in TaskDetail.
  - Flipping to main leaves the `nc/<taskId>` worktree + branch orphaned on disk
    (nothing calls `worktree::remove`), and leaves the stale `task.branch` chip set.
  - `merge_task` then refuses the task as main-mode (`workflow/merge/integrate.rs:21-30`,
    `refuse_main_mode_merge`), and the board would re-file the card as a Main task
    with a dangling branch — an inconsistent state.
- Automaker makes this a one-drag operation to the Main tab (`branchName = undefined`,
  `use-board-drag-drop.ts:151`) and its worktree-delete path auto-migrates orphaned
  features to main (`delete.ts:147-189`).

### "Verified" is a column in Automaker, a boolean in Nightcore

- Automaker has a literal **Verified** board column
  (`apps/ui/src/components/views/board-view/constants.ts:95-96`) and a `verified`
  `FeatureStatus` (`libs/types/src/feature.ts:113`).
- Nightcore has **no Verified column** — six columns Backlog · In Progress ·
  Verifying · Waiting Approval · Done · Failed (`board/status.ts:21-63`); "verified"
  is a boolean flag set alongside `status = Done` (`workflow/merge/review.rs:46-60`).
  So "preserve the task in Verified" maps to "keep the Done+verified card."

## Capability Matrix (worktree/branch operations, backend command + UI trigger)

Legend: ✅ full · 🟡 partial/indirect · ❌ absent

| Capability | Nightcore | Automaker |
|---|---|---|
| Create worktree for a task/feature | ✅ auto on run, task-id-keyed (`cwd.rs`, `lifecycle.rs:17`) | ✅ explicit, branch-keyed, reuses existing (`create.ts`) |
| Custom branch / base at create | ✅ create form picker (`NewTaskForm.hooks.ts:165-166`) | ✅ create-worktree dialog + baseBranch |
| List branches (picker) | ✅ `list_branches` (`commands/worktree.rs:34`) | ✅ `list-branches`, `branch-autocomplete` |
| Switch branch inside a worktree | ❌ none | ✅ `switch-branch` + `checkout-branch` + branch-switch dropdown |
| Per-worktree live status (dirty/ahead/behind/changed) | ✅ `WorktreeStatus` monitor (`worktree/status.rs:36-59`) | ✅ richer (PR/dev/auto/test/conflict badges in dropdown trigger) |
| View diff vs base | 🟡 `worktree_diff`, base-relative, in Worktrees view (`commands/worktree.rs:98`) | ✅ `diffs` + `file-diff` per-file viewer |
| Merge preview (read-only) | ✅ `merge_preview` merge-tree (`commands/worktree.rs:47`) | 🟡 via diffs/commit-log; merge dialog |
| Merge/integrate branch → base | ✅ `merge_task`, gated, abort-not-force (`merge/integrate.rs:52`) | ✅ `merge` (Integrate Branch) |
| Honor cleanup-on-merge | ✅ `cleanupWorktrees` (`merge/integrate.rs:150-156`) | ✅ post-merge prompt dialog |
| **Discard worktree, keep task** | 🟡 `discard_worktree` exists but only in Worktrees view, not board (`commands/worktree.rs:130`) | ✅ delete-worktree keeps feature, migrates to main (`delete.ts:147-189`) |
| Delete task/feature record | ✅ `delete_task` (also nukes worktree) (`commands/task.rs:186`) | ✅ separate from worktree delete |
| **Assign task to existing worktree** | ❌ task-id-keyed, no re-point | ✅ drag to worktree tab (`use-board-drag-drop.ts:136-172`) |
| **Move task back to main/repo-root** | 🟡 `run_mode` patchable, no UI/no cleanup | ✅ drag to Main tab → `branchName=undefined` |
| Commit inside worktree | ✅ `commit_task` (`merge/commit.rs`) | ✅ `commit` + AI commit-message |
| Push branch | 🟡 only via PR create flow | ✅ `push` / push-new-branch, per-remote |
| Pull / update base | 🟡 `pull_base_ff` (ff-only, PR flow) (`pr_status/pull.rs`) | ✅ `pull` + `sync` per-remote |
| Create PR | ✅ `create_pr_task` (`workflow/pr/create.rs`) | ✅ `create-pr` + `generate-pr-description` |
| Address PR comments (AI) | ✅ `address_pr_comments` | ✅ manage + auto-address |
| Rebase | ❌ | ✅ `rebase` |
| Cherry-pick | ❌ | ✅ `cherry-pick` |
| Stash push/list/apply/drop | ❌ | ✅ full stash suite |
| Abort/continue in-progress merge/rebase | ❌ | ✅ `abort-operation` / `continue-operation` |
| Resolve conflicts with AI (feature) | ❌ | ✅ create-conflict-resolution-feature |
| Open worktree in editor | ❌ (`open_external` opens PR URLs only) | ✅ `open-in-editor` (multi-editor) |
| Open worktree in terminal | ❌ | ✅ integrated + external terminals |
| Dev server per worktree (start/stop/logs) | ❌ | ✅ start/stop/list/logs |
| Test runner per worktree | ❌ | ✅ start/stop/logs |
| Init script / copy configured files into worktree | ❌ | ✅ `init-script` + `copyConfiguredFiles` |
| Swap worktree into a pinned slot | ❌ | ✅ swap-worktree submenu (`worktree-actions-dropdown.tsx:1421-1450`) |
| Per-branch card-count badge | 🟡 worktree tabs group by branch | ✅ `branchCardCounts` badge |

## Adjacent capabilities Automaker has that the user did NOT name (roadmap candidates)

Grounded in `apps/server/src/routes/worktree/index.ts` (50+ endpoints) and
`worktree-actions-dropdown.tsx`:

- **Diff-against-base + per-file diff viewer** (`diffs.ts`, `file-diff.ts`) — richer
  than Nightcore's single `worktree_diff` blob.
- **Branch switching / checkout inside a worktree** (`switch-branch`, `checkout-branch`).
- **Open worktree in editor** (multi-editor detection) and **in terminal**
  (integrated + external) — the single most common "I want to poke at this
  worktree myself" affordance, entirely absent in Nightcore.
- **Per-worktree dev server** (start/stop/logs, port detection badge) and **test
  runner** (start/stop/logs, pass/fail badge).
- **Stash management, cherry-pick, rebase, abort/continue** conflict operations.
- **"Resolve conflicts with AI"** — spawns a feature to fix a merge/rebase conflict.
- **Rich per-worktree status indicators** on the dropdown trigger: PR state,
  dev-server, auto-mode, test result, uncommitted-changes count, conflict type
  (`worktree-dropdown.tsx:326-441`).
- **Init scripts + configured-file copy** into a freshly created worktree
  (`create.ts:293-305`, `runInitScript`).
- **Swap worktree into a pinned tab slot** (`worktree-actions-dropdown.tsx:1421-1450`).

## Recommended Approach (prioritized)

### Quick wins (small, high-value, no model change)

1. **Surface `discard_worktree` on the board Done/Verified card** (Gap 1). The
   command already exists and preserves the task; wire a "Delete worktree (keep
   task)" action into `TaskDetail` for a Done worktree-mode task, mirroring the
   WorktreeManager row action. Also clear the stale `branch` chip / flip
   `run_mode`→main on discard so the card reads consistently. Files:
   `apps/web/src/components/board/TaskDetail/*`, reuse
   `bridge/commands.ts:discardWorktree`. **Mostly UI — coordinate with kirei-ui.**
2. **Add "Open worktree in editor / terminal / Finder"** for a worktree task — the
   highest-ROI adjacent capability and a self-contained new command (no lifecycle
   coupling). Nightcore already has `open_external`; add a reveal-path / open-in-app
   command.

### Structural work (needs a domain-model change — this is kirei-arch's lens)

3. **Gap 3 (move-to-main)** as a first-class command: `move_task_to_main(id)` that
   sets `run_mode=main`, removes the `nc/<taskId>` worktree + branch, and clears
   `branch`/`base_branch`. Medium effort; reuses `worktree::remove` +
   `delete_branch_named`. UI: a card action + optionally a drag target.
4. **Gap 2 (assign to existing worktree)** is the deepest change: it requires
   decoupling the worktree dir from the task id (a branch-keyed or explicit
   `worktree_id` model) so multiple tasks can target one checkout — or at minimum a
   `branch` field on `TaskPatch` plus a shared-worktree allocation path. This is a
   domain-model fork toward Automaker's `branchName`-pointer model and should be
   scoped by kirei-arch. Flag: this collides with the current single-writer
   worktree-confinement and slot-lease invariants (running-task guard, isolation
   chokepoint), so concurrency safety must be re-derived.

## Files to Modify (indicative — not an implementation plan)

- `apps/web/src/components/board/TaskDetail/TaskDetail.{tsx,hooks.ts}` — surface
  discard + move-to-main card actions (Gap 1, Gap 3 UI).
- `apps/desktop/src-tauri/src/commands/worktree.rs` — new `move_task_to_main` (Gap
  3); a reveal/open-in-editor command (adjacent).
- `apps/desktop/src-tauri/src/store/task/patch.rs` — add `branch`/`base_branch` (or
  a dedicated re-target command) if Gap 2 is pursued.
- `apps/desktop/src-tauri/src/orchestration/coordinator/cwd.rs` +
  `apps/desktop/src-tauri/src/worktree/lifecycle.rs` — worktree keying change for
  Gap 2 (structural).
- `apps/desktop/src-tauri/src/lib.rs` — register any new commands.

## Reference Files (do not modify — Automaker patterns to port the *idea* of)

- `automaker/apps/server/src/routes/worktree/routes/delete.ts:147-189` — preserve
  feature on worktree delete by re-pointing to main.
- `automaker/apps/ui/.../hooks/use-board-drag-drop.ts:127-172` — assign/move a card
  to a worktree by drag.
- `automaker/libs/types/src/feature.ts:96` — the mutable `branchName` pointer.
- `automaker/apps/ui/.../worktree-panel/components/worktree-actions-dropdown.tsx` —
  the full action menu (kirei-ui lens).

## Risks & Gotchas

- Nightcore's isolation model (`git_command` chokepoint, `is_under` guard,
  slot-lease running-guard) is the security spine — Gap 2's shared-worktree model
  must not weaken the workspace-confinement seam or the "refuse while running"
  guard (`commands/worktree.rs:146-152`).
- After a discard, a Done card retains `run_mode=worktree` + a stale `branch`; any
  Gap-1 UI must reconcile that or Merge/Create-PR affordances will mislead.
- Generated contracts are codegen'd both ways — a `TaskPatch` change (Gap 2)
  regenerates `TaskPatch.ts` via `cargo test`; do not hand-edit.

## How to Verify

- Gap 1: a Done worktree task shows a "Delete worktree (keep task)" action; after
  invoking, the worktree dir/branch are gone but the card stays in Done/verified.
- Gap 3: a worktree task can be moved to Main; its `nc/<taskId>` worktree+branch are
  removed and it no longer shows a branch chip.
- Gap 2 (if pursued): two tasks can target one branch/checkout, or a task can be
  re-pointed at another task's branch, with the running-guard still refusing live moves.

## Open Questions

- Does the user want Gap 2's *shared* running worktree (multiple tasks, one
  checkout) or merely the ability to *re-point* a task at an already-created branch?
  The former is a concurrency-model change; the latter is a `TaskPatch.branch` +
  re-allocate command. (Recommend confirming scope before kirei-arch designs it.)
- Should discard auto-transition `run_mode`→main, or keep the task worktree-mode
  with an empty-worktree state? Affects Gap 1 ↔ Gap 3 overlap.
