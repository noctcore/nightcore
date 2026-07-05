# Combined Findings: Worktree Parity — Nightcore vs Automaker

**Date:** 2026-07-05
**Skill:** /kirei-chain
**Lenses:** arch, ui, general
**Scope:** Why Automaker's branch/worktree system is more capable than Nightcore's, and what it takes to close three user-named gaps: (1) delete worktree but keep the task in Verified, (2) push a task into an existing running worktree, (3) move a task back to the main board.

## Per-Lens Reports
- **Architecture:** docs/arch/2026-07-05-worktree-lifecycle-coupling-vs-automaker.md
- **UI/UX:** docs/ui/2026-07-05-worktree-ux-comparison.md
- **General/Product:** docs/research/2026-07-05-worktree-capability-gap-automaker-vs-nightcore.md

## Cross-Cutting Themes

### 1. One root cause, three symptoms (found independently by all three lenses)
Nightcore keys a worktree by **task id** and welds it 1:1 to the task: dir is `<project>/.nightcore/worktrees/<taskId>`, branch is `nc/<taskId>` (`apps/desktop/src-tauri/src/worktree/path.rs:12,22`), and the worktree has **no store record and no mutable pointer** — `Task` has no `worktree_ref`/`branch-target` field (`store/task/model.rs:218-386`; `TaskPatch` cannot set `branch`, `store/task/patch.rs:36-70`). Automaker keys worktrees by **branch** and gives each feature a mutable `branchName?: string | null` pointer (`libs/types/src/feature.ts:95-96`; `null` = main), with worktrees enumerated live from `git worktree list --porcelain` and a persistent branch registry (`active-branches.json`). In Automaker all three of the user's asks are just "re-point `branchName`"; in Nightcore none of them have a seam to hang on.

### 2. Gap 1 is ~80% already built — it's a surfacing + copy problem
`discard_worktree` (`commands/worktree.rs:131-164`) already removes the worktree + branch, keeps the task and its status, clears conflict/error, and refuses while running (slot-lease guard). The bridge doc even says it is "distinct from deleting the task" (`apps/web/src/lib/bridge/commands.ts:533-538`). But it is only reachable from the separate Worktrees nav view — never from the TaskCard/TaskDetail on the board — and `DiscardDialog` copy never says the task survives. The user believes the capability doesn't exist because the UI hides it.

### 3. Gap 3 is half-built and currently leaks
`TaskPatch.run_mode` is patchable pre-run via SessionCard's WorkModePicker, but there is no post-run "move back to main". Worse, flipping Worktree→Main clears the branch chip (`orchestration/coordinator/reconcile.rs:35`) but **orphans `worktrees/<taskId>` forever** (arch's secondary-leak finding), and a stale chip/`run_mode` after discard makes Merge/Create-PR affordances mislead (general's gotcha). Any fix should be one atomic backend verb, not a two-step client dance.

### 4. The dropdown gap is real and two-layered
Automaker's board-resident `worktree-actions-dropdown.tsx` (~1,460 lines, ~30 actions: per-remote pull/push with ahead/behind badges, sync, merge/rebase, cherry-pick, stash, dev-server, test-runner, open-in-editor/terminal, PR submenu, swap-worktree, delete-worktree; path: `apps/ui/src/components/views/board-view/worktree-panel/components/`) sits on nested submenus + split-buttons + inline state badges. Nightcore's `ui/Menu.tsx:14-20` is a **flat** `{label, icon, onClick, destructive}` primitive — the UI layer literally cannot express Automaker's menu — and its worktree actions (Diff/Merge/Discard) live off-board in the Worktrees view. Closing the gap needs both a richer Menu primitive and moving actions onto the board.

### 5. Terminology nuance
Nightcore has no actual "Verified" column — verified is a boolean on Done (`apps/web/src/components/board/status.ts:21-63`); Automaker has a literal Verified column. "Preserve the task in Verified" concretely means: task stays Done + verified flag intact after worktree cleanup — which `discard_worktree` already satisfies.

## Conflicts Between Lenses
- **Discard vs soft-cleanup:** kirei-ui proposes surfacing existing `discardWorktree` on the card (quick win); kirei-arch proposes a NEW softer `cleanup_worktree` verb that reclaims the checkout dir but **keeps the branch ref** (plus a branch registry). These are different verbs — discard deletes the branch too. **Resolution:** ship the surfacing quick-win now with honest copy ("removes worktree and its branch; the task stays on the board"), and add the branch-preserving verb only as part of the Gap-2 branch-registry work where it pays for itself.
- **Gap 3 shape:** kirei-ui sketches a client-side two-step (`updateTask runMode→main` + optional discard confirm); kirei (general) recommends an atomic `move_task_to_main(id)` command. **Resolution:** atomic backend command wins — it closes the reconcile orphan-leak and stale-chip hazards in one place.
- **Gap 2 scope (open question for the user):** re-point a task at an existing branch/worktree (cheap-ish: nullable `Task.worktree_ref` + cwd resolution) vs true shared multi-task running worktrees (concurrency-model change). `WorktreeStatus.task_ids` is already a `Vec` explicitly "so a later shared-board model fits" (`worktree/status.rs:41-44`) — the contract anticipates sharing, but the slot-lease/confinement model does not yet.

## Unified Priority Order
1. **Surface Gap 1 on the board** — "Delete worktree (keep task)" in TaskDetail done-footer + fix `DiscardDialog` copy to say the task stays. Backend exists; pure UI. — ui, general
2. **`board/TaskActionsMenu` kebab on TaskCard** (matches ProjectCard convention) — anchor point for #1, #3, and future worktree actions. — ui
3. **Atomic `move_task_to_main(id)` command** (flip run_mode + remove worktree/branch + clear chip, running-guarded) — closes Gap 3 AND the reconcile orphan leak. — general, arch
4. **Diff from the board** — reuse `DiffViewDialog` from card/detail so "see this task's changes" doesn't need the Worktrees nav trip; extend `ui/Menu` with submenu/badge support. — ui
5. **Gap 2 structural work** (kirei-forge, after scoping): nullable `Task.worktree_ref` honored by `coordinator/cwd.rs`, branch-keyed worktree resolution, optional `active-branches.json` registry; must preserve `is_under` confinement + slot-lease invariants; `cargo test` regenerates ts-rs bindings. — arch
6. **Adjacent adoptions from Automaker** (unrequested but likely wanted): open-in-editor/terminal, per-remote pull/push/sync with ahead-behind badges, PR status on worktree tabs, drag-card-onto-worktree assignment. — ui, general

## Recommended Execution Strategy
Three waves, committed straight to main per repo convention (small conventional commits, no branches/PRs):
- **Wave 1 (kirei-build, ships this week):** items 1–3. Pure UI surfacing + one small guarded Tauri command. Each independently committable.
- **Wave 2 (kirei-build):** item 4 — Menu primitive upgrade + diff-on-board; polish-ui/impeccable:clarify for the dialog copy.
- **Wave 3 (kirei-forge, gated on user scope decision):** item 5 (Gap 2). Confirm re-point vs shared-worktree first; one boundary at a time behind nullable fields so id-scoped worktrees never regress.

## Confirmed Task Scope (user-approved 2026-07-05)

The user reviewed the findings and locked the scope for the implementation task:

**Blockers — ALL FOUR in scope:**
1. Surface "Delete worktree (keep task)" on TaskCard/TaskDetail with honest copy (Gap 1)
2. `board/TaskActionsMenu` kebab on TaskCard (anchor for worktree actions)
3. Atomic `move_task_to_main(id)` Tauri command (Gap 3 + reconcile orphan-leak fix)
4. Gap 2 — assign task to existing worktree, **RE-POINT MODEL ONLY**: a task can be pointed at an existing branch/worktree, but only one task runs in a checkout at a time. Slot-lease and `is_under` confinement invariants must be preserved unchanged. Shared multi-task worktrees are explicitly out of scope.

**Automaker ports — after the blockers, same task:**
- **Rich worktree dropdown** — extend `ui/Menu` with submenus/split-buttons/inline badges; move worktree actions onto the board
- **Drag card onto worktree** — worktree tabs as dnd drop targets to assign a task (builds on the Gap 2 re-point backend)
- **PR badges on worktree tabs** — PR status inline on the switcher/tabs + PR submenu
- **Pull/push/sync + badges** — per-remote pull/push/sync with ahead/behind and local-only/tracking badges
- **Cherry-pick + stash** — view commits → cherry-pick, view changes → stash

**Explicitly deselected (do NOT build in this task):** diff-from-board DiffViewDialog reuse, open-in-editor/terminal, per-worktree dev-server/test-runner. Deferring Gap 2 was offered and declined — it is in scope.

**Suggested build order within the task:** blockers 1→2→3 (each independently committable, kirei-build-sized) → Gap 2 re-point backend (kirei-forge-sized: nullable `Task.worktree_ref` + `coordinator/cwd.rs` resolution + `cargo test` to regen ts-rs bindings) → Menu primitive upgrade → dropdown actions (pull/push/sync, cherry-pick, stash) → PR badges → drag-to-assign last (depends on both Gap 2 backend and dnd surface).

## Out of Scope (Surfaced but Not Investigated)
- **Route-breadth gap:** Automaker exposes ~49 worktree/branch backend operations vs Nightcore's ~7 (rebase, cherry-pick, stash, sync, dev-server, test-runner…) — each a candidate follow-up /kirei once the foundation lands.
- **Security posture of Gap 2:** widening worktree targeting must not weaken the workspace-confinement PreToolUse gate or per-root mutation lease — worth a focused kirei-security pass when Wave 3 is designed.
- **Automaker's Auto-Mode-per-worktree and conflict-resolve-with-AI flows** — noted by ui lens, not analyzed.
