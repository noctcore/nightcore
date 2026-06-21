# Worktree model: AutoMaker vs Nightcore — findings + redesign

Date: 2026-06-21
Status: research only, no code changes
Repos:
- Nightcore (the app): `/Users/shirone/Documents/Projects/nightcore`
- AutoMaker (reference predecessor): `/Users/shirone/Documents/Projects/automaker`

Two problems surfaced in a live dogfood run:
- **A.** A worktree was created even though the user expected the edit to land on `main` — there is no per-task opt-in; every run on an active project is auto-isolated.
- **B.** The verification reviewer reported a clean/empty tree ("not implemented") while the README edit *did* exist, **uncommitted**, in the worktree.

---

## PART A — Nightcore's current worktree behavior (and why the implicit worktree happened)

### A.1 Every run on an active project auto-allocates a worktree — no opt-in

The launch path is `coordinator.rs::launch` → `resolve_worktree`:

- `apps/desktop/src-tauri/src/m2/coordinator.rs:339` — `let cwd = match resolve_worktree(app, task_id)` is called for **every** launch; there is no conditional on a per-task flag.
- `apps/desktop/src-tauri/src/m2/coordinator.rs:411-426` — `resolve_worktree`:
  - `:413` `let Some(project) = projects.active() else { return Ok(None); }` — **the ONLY way to run without a worktree is to have no active project.**
  - `:417` refuses to allocate if the base tree is dirty.
  - `:423` `let dir = worktree::allocate(&project_path, task_id)?;` — otherwise it **always** allocates.

So the exact condition is binary and implicit:

> **active project present ⇒ ALWAYS a `nc/<taskId>` worktree; no active project ⇒ run in workspace root (M1 behavior).**

The run's cwd is set to the worktree at `coordinator.rs:396` (`cwd` passed into `provider.start_session(...)`). The task's branch chip is set from the allocated worktree at `coordinator.rs:359-361` and `:372-374` (`t.branch = Some("nc/<id>")`).

This is the surprise: the user had an active project, so the edit was silently isolated into `<project>/.nightcore/worktrees/<id>/` on branch `nc/<id>` instead of touching `main`.

### A.2 worktree.rs map (the full surface)

File: `apps/desktop/src-tauri/src/m2/worktree.rs`

| Concern | Where | Behavior |
|---|---|---|
| Branch name | `:26-28` `branch_name` | `nc/<taskId>` (hardcoded prefix) |
| Folder location | `:31-38` `worktrees_base` / `worktree_path` | `<project>/.nightcore/worktrees/<taskId>` (flat, per-task-id; `.nightcore/` is gitignored) |
| Base branch | `:186-191` `base_branch` | `git rev-parse --abbrev-ref HEAD` of the main checkout, fallback `main`. Worktree branches **off current HEAD** (`allocate`) |
| Dirty-base guard | `:68-71` `is_worktree_clean` | `git status --porcelain` must be empty or the loop refuses (`coordinator.rs:417`) |
| Allocate | `:76-102` `allocate` | `git worktree add <dir> -b nc/<id>` (or reuse existing branch/dir; idempotent on crash-recovery) |
| Commit (worktree-confined) | `:131-146` `commit` | `git add -A` + `git commit -m`; returns `Ok(false)` on nothing-to-commit. **Only called by the manual `commit_task` command** (see B.5) |
| Merge | `:153-172` `merge` | checks out base in main checkout, `git merge --no-edit nc/<id>`; aborts on conflict (never `--force`) |
| Remove | `:107-124` `remove` | `git worktree remove --force` (force *because the agent leaves uncommitted edits* — see `:120-121`), refuses paths outside the base (`:110`) |
| Delete branch | `:195-201` `delete_branch` | best-effort `git branch -D nc/<id>` |
| Reconcile | `:237-250` `reconcile` | prune worktrees whose task id is no longer live + `git worktree prune` |
| Cleanup policy | `coordinator.rs:444-460` `cleanup_worktree` | only on success **and** `cleanup_worktrees` setting; failed/cancelled retained for inspection |

### A.3 There is NO "run on main vs run in worktree" choice anywhere

- `Task` model — `apps/desktop/src-tauri/src/task.rs:70-130`: fields are `id, title, description, status, dependencies, model, branch, …, kind, verified, review, fix_attempts`. **No `run_on_main` / `isolation` / `work_mode` field.** `branch` is an *output* (set by the coordinator), not an input.
- `TaskPatch` — `task.rs:174-181`: patchable fields are `title, description, status, dependencies, model, kind`. No isolation field.
- `Settings` — `apps/desktop/src-tauri/src/settings.rs:23-37`: only `cleanup_worktrees: bool` (global). No per-project or per-task run-location setting. `SettingsOverride` (`:59-63`) and `SettingsPatch` (`:95-103`) likewise.
- Contracts — `packages/contracts/src/*`: `TaskKind = build | research | review | decompose` (`bridge.ts:27`), no isolation field on the task contract.
- Web — `apps/web/src`: worktrees appear only as a **settings page** (`SettingsView.tsx:436-453`: base dir display + cleanup toggle). The board's `build` kind is hardcoded as "Write code in an isolated worktree, then verify" (`board/status.ts:144`). **No per-task toggle at creation.**

> **Conclusion (A):** Worktree isolation is an implicit, non-negotiable consequence of having an active project. The user has no way to say "this task edits main directly."

---

## PART B — The verification-gate reviewer bug (root cause + fix)

### B.1 The reviewer's cwd and the comparison it's told to make

Reviewer dispatch: `apps/desktop/src-tauri/src/sidecar.rs`

- cwd: `dispatch_reviewer` runs the reviewer session **in the worktree** — `sidecar.rs:475` passes `Some(worktree_dir.to_path_buf())` as cwd; `worktree_dir` is `verification_worktree(...)` = `<project>/.nightcore/worktrees/<id>` (`sidecar.rs:439-443`). **The cwd is correct — the reviewer is in the same dir the build wrote to.** This rules out the "different cwd" hypothesis.
- base branch injected: `reviewer_base_branch` (`sidecar.rs:515-520`) = `worktree::base_branch(project)` = the main checkout's current branch (e.g. `main`).
- the prompt (`sidecar.rs:525-541`):

  ```
  Inspect ALL changes relative to base branch `{base}`: run `git status`,
  `git diff {base}...HEAD`, and check untracked files.
  ```

### B.2 Root cause — committed-only diff over an uncommitted change

The reviewer is told to judge via `git diff {base}...HEAD` (a **commit-range** diff: `main`'s merge-base vs the worktree branch's `HEAD` commit). But:

- The build session **never commits**. It writes files into the worktree working tree and exits. Nothing in `handle_build_completed` commits before review — `sidecar.rs:288-302` forgets the build session and immediately calls `dispatch_reviewer` with `Verifying` status; there is no `worktree::commit` call on this path.
- Therefore the worktree's `HEAD` is **identical to `main`** (the branch was created off HEAD at `allocate` and never advanced). `git rev-list --count main..HEAD` = `0`, `git diff main...HEAD` = empty — exactly what the reviewer reported.
- The actual change is an **uncommitted working-tree edit** (and/or an untracked file), visible only via `git status --porcelain` + `git diff` (no range) + untracked-file listing.

The prompt *does* say "run `git status` … and check untracked files," but it frames `git diff {base}...HEAD` as the authoritative diff and the verdict format rewards a single committed-range judgment — so a literal-minded reviewer concludes "rev-list count is 0, tree clean per the range, nothing implemented." The contradiction is **structural**, not a cwd mistake: the gate reviews committed history while the build produces uncommitted working-tree state.

This is confirmed by `worktree.rs:120-121`, which documents the same fact from the other side: *"`--force` because the agent's run leaves uncommitted edits in the worktree."* The system already knows the build leaves uncommitted edits — but the reviewer prompt diffs as if they were committed.

### B.3 The precise fix (two viable options; recommend both)

**Option 1 (recommended primary): commit the build's work in the worktree before review.**
`worktree::commit` already exists and is worktree-confined (`worktree.rs:131-146`). In `handle_build_completed`, *before* `dispatch_reviewer` (between `sidecar.rs:294` and `:302`), call `worktree::commit(project_path, task_id, <wip-message>)`. Then `git diff {base}...HEAD` is non-empty and `rev-list --count base..HEAD` > 0, and the existing prompt works unchanged. This also makes `committed` semantics real for the auto-loop (today `committed` is only ever set by the manual `commit_task`).
- Caveat: if you auto-commit a WIP, the later manual `commit_task` (`merge.rs:38-53`) would report "nothing to commit." Either skip the manual commit when already committed, or have `commit_task` amend/reword. Keep the auto-commit message clearly WIP (e.g. `nightcore(wip): <title>`), and have `merge_task` squash on merge if a clean history is wanted.

**Option 2 (defense-in-depth, do regardless): make the reviewer inspect working-tree state, not just the committed range.**
Rewrite the reviewer prompt (`sidecar.rs:525-541`) so the authoritative signal is the working tree:
- `git status --porcelain` (staged + unstaged + untracked),
- `git diff` and `git diff --cached` (uncommitted changes),
- explicitly read untracked files' contents,
- treat `git diff {base}...HEAD` as *supplementary* (only meaningful once commits exist).
This makes the gate correct whether or not the build committed, and is robust to a build that partially commits.

> **Recommendation:** do **Option 1** (commit-before-review, so the whole build→commit→review→merge lifecycle operates on real commits) **and** **Option 2** (reviewer reads working-tree state too, as a belt-and-braces guard).

### B.4 Why the cwd theory is wrong (explicitly ruled out)

`verification_worktree` (`sidecar.rs:439-443`) and `dispatch_reviewer` (`sidecar.rs:475`) both resolve `worktree::worktree_path(project, task_id)` — the *same* path the build's cwd was set to (`coordinator.rs:396` via `resolve_worktree`). The reviewer is in the right directory. The bug is purely the committed-vs-working-tree comparison.

### B.5 Lifecycle map — build writes → (no commit) → review → verified → commit_task → merge_task

| Step | Where | Commits? |
|---|---|---|
| Build writes | `coordinator.rs:388-401` start_session, cwd = worktree | writes files only, **no commit** |
| Build completes → gate | `sidecar.rs:260-311` `handle_build_completed` | **no commit**; sets `Verifying`, dispatches reviewer |
| Review | `sidecar.rs:457-481` `dispatch_reviewer`; prompt `:525-541` | reads — sees empty committed range (the bug) |
| Verdict PASS | `sidecar.rs:335-348` | sets `verified=true`, `Done`; cleanup per policy. **Still uncommitted in worktree** |
| CHANGES_REQUESTED | `sidecar.rs:350-372` | bounded auto-fix (`dispatch_fix`, same worktree) or park |
| `commit_task` (MANUAL) | `merge.rs:37-53` `#[tauri::command]` | `worktree::commit` — **the only commit in the whole pipeline today** |
| `merge_task` (MANUAL) | `merge.rs:58-111` `#[tauri::command]` | runs gauntlet, `git merge nc/<id>` into base |

> The build's output is therefore **never committed by the autonomous loop** — it sits as working-tree edits until the user manually clicks commit. The gate, the breaker-success accounting, and the verdict all run over a worktree whose `HEAD == base`. This single fact explains Part B end-to-end.

---

## PART C — How AutoMaker models worktrees / branches / boards (the target UX)

AutoMaker tasks are **"features"**; persisted as JSON (no DB). Server = Express (`apps/server/src`), UI = React + Zustand (`apps/ui/src`), git helpers in `libs/git-utils/src`.

### C.1 Run-mode is an explicit, per-feature 3-way choice ("Work Mode")

- `WorkMode = 'current' | 'auto' | 'custom'` — `apps/ui/src/components/views/board-view/shared/work-mode-selector.tsx:8`, options at `:22-41`:
  - `current` = work directly on the selected branch (i.e. **no new worktree**),
  - `auto` = create an isolated worktree automatically,
  - `custom` = specify a branch name.
- Rendered as a 3-button group in the Add Feature dialog — `add-feature-dialog.tsx:171` (`useState<WorkMode>('current')`), `:688` renders `WorkModeSelector`.
- Persisted as a single nullable field `branchName` on the feature model — `libs/types/src/feature.ts:96` (`branchName?: string | null; // null = use current worktree`). Mode is derived back from data in the edit dialog.
- Project default comes from a global `useWorktrees: boolean` + per-dialog defaults in the Zustand store (`apps/ui/src/store/app-store.ts:307-308`); `getDefaultWorkMode()` picks the initial mode (`add-feature-dialog.tsx:60-75`).
- At execution the server branches purely on `branchName`: `apps/server/src/services/execution-service.ts:224-235` — `if (!worktreePath && useWorktrees && branchName) { …resolve worktree… } else { workDir = projectPath }`. So **empty branchName ⇒ runs in the project root checkout (on main/current).**

> **The core lesson:** the worktree-vs-main decision is an explicit per-task selection made at creation, collapsed to one nullable field. Nightcore has no equivalent.

### C.2 What a worktree feature creates

- **Branch name** (client-side, `use-board-actions.ts`):
  - `auto` (`:199-209`): `feature/<title-slug>-<rand4>` (slug = lowercased title, non-alphanumeric→`-`, capped 50, plus a 4-char suffix).
  - `custom` (`:212`): user-supplied, normalized (strips `refs/heads/`, `origin/`, …).
  - `current` (`:198`): inherits the currently-active worktree's branch.
- **Worktree folder** (server-side, `apps/server/src/routes/worktree/routes/create.ts:174-177`): `<projectPath>/.worktrees/<sanitized-branch>` (in-repo, gitignored). Created via `git worktree add -b <branch> <path> <base>` (`:263-266`); base defaults to `HEAD`, can be `origin/main`, and is **fetched + fast-forward-synced first** (`:182-245`).
- **Board placement:** worktree features and main features share **one unified kanban board**; columns are the feature's status/category, independent of branch. There is **no separate board per worktree** — worktrees are a tab/switcher strip above the single board.

### C.3 Switching & monitoring multiple worktrees

- **Worktree switcher:** pinned worktree **tabs** on desktop (`apps/ui/src/components/views/board-view/worktree-panel/worktree-panel.tsx`; main always slot 0), dropdown on mobile (`worktree-mobile-dropdown.tsx`), per-worktree branch switch (`branch-switch-dropdown.tsx`).
- **"Active worktree" state (Zustand, `app-store.ts`):** `currentWorktreeByProject` (`:309`), `setCurrentWorktree`/`getCurrentWorktree` (`:1205`/`:1219`); pinned tabs `pinnedWorktreeBranchesByProject` (`:404`); all worktrees `worktreesByProject` (`:310`).
- **Monitoring parallel runs:** `autoModeByWorktree: Record<"${projectId}::${branch ?? '__main__'}", { isRunning, runningTasks, … }>` (`app-store.ts:115-123`); each tab shows its own running badge. Auto-mode loops are **per-worktree with independent concurrency**, keyed `projectPath::branch` (`apps/server/src/services/auto-loop-coordinator.ts:48`, `:516`).
- New features default to the **active worktree's branch** (`use-board-actions.ts:228`) — a "you're working in context X" affordance.

### C.4 Lifecycle (commit → diff → review → merge → cleanup)

- **Commit:** mostly **user-triggered** (`apps/server/src/routes/worktree/routes/commit.ts:16-65`, `git add -A` + commit, with AI-generated messages). Auto-commit only happens during PR creation if there are uncommitted changes (`create-pr.ts:124-149`). The agent run itself only writes files.
- **Diff:** against the **working tree**, not a committed range — `getGitRepositoryDiffs()` runs `git diff HEAD` + `git status --porcelain` and **synthesizes diffs for untracked files** (`libs/git-utils/src/diff.ts:249-409`). (This is exactly the working-tree-aware diff Nightcore's reviewer is missing.)
- **Review / gate:** optional, configurable **pipeline** (`pipeline-orchestrator.ts:73-159`) with an optional test step + retry-and-fix loop (`:473-535`) and an optional human plan-approval gate (`plan-approval-service.ts`). No mandatory automated reviewer.
- **Merge:** auto-merge at pipeline end if the feature has a worktree (`pipeline-orchestrator.ts:155-158` → `attemptMerge` `:579-631`, `deleteWorktreeAndBranch:false`), or manual `POST /merge` (`merge-service.ts:46-231`, supports `--squash`, 3-layer conflict detection). Conflicts set status `merge_conflict`.
- **Cleanup:** **manual** `POST /delete` (`worktree/routes/delete.ts:19-205`: `git worktree remove --force`, optional branch delete) — and notably it **migrates orphaned features back to main** by setting `branchName: null` (`:150-189`) so deleting a worktree never loses task cards.

### C.5 Other UX worth porting

- Branch-per-task under in-repo gitignored `.worktrees/` (Nightcore already mirrors this with `.nightcore/worktrees/`).
- **One board, many worktrees via pinned tabs** + an explicit "active worktree" concept.
- **Per-worktree auto-loops with independent concurrency** keyed by `project::branch`.
- Configured-file copy into new worktrees (`worktree-service.ts copyConfiguredFiles`, setting `worktreeCopyFiles`) + async init script (`init-script-service.ts`) — handles `.env`/deps not in git. (Nightcore's settings page already *shows* "Files to copy into each worktree" at `SettingsView.tsx:446` — currently roadmap-only.)
- GitHub PR integration with AI-generated descriptions (`create-pr.ts`).
- Base-branch sync (fetch + fast-forward) before worktree creation.
- Feature-migration-on-delete (orphaned cards reassigned to main).

---

## PART D — Redesign proposal for Nightcore

Two independent changes: **(D1)** make isolation an explicit per-task choice (fixes Part A), and **(D2)** fix the build→commit→review→merge lifecycle (fixes Part B). D2 is small and should ship first/standalone; D1 is the larger UX change.

### D1 — Explicit per-task run mode ("on main" vs "in a worktree")

Port AutoMaker's `WorkMode`, simplified to Nightcore's single-repo model. Recommended enum:

```
RunMode = "main" | "worktree"        // start here; add "custom-branch" later
```

- **`main`** — run with `cwd = project root`, no worktree, edits land on the project's current branch directly (the behavior the user expected). Reuse the existing "no worktree to diff ⇒ finish as M3" path (`sidecar.rs:274`) so the verification gate is naturally skipped (or, optionally, run the gate against working-tree state — see D2).
- **`worktree`** — today's behavior: allocate `nc/<id>`, gate, commit, merge.

Tier mapping + sizing:

| Tier | File(s) | Change | Size |
|---|---|---|---|
| Rust core | `task.rs:70-130` | add `run_mode: RunMode` to `Task` (default `worktree` to preserve current behavior, OR `main` if you want safe-by-default) | S |
| Rust core | `task.rs:174-187` | add `run_mode` to `TaskPatch` + `apply` | S |
| Rust core | `coordinator.rs:411-426` `resolve_worktree` | branch on `task.run_mode`: `main ⇒ Ok(Some(project_root))` (or `Ok(None)` to reuse workspace-root semantics) vs `worktree ⇒ allocate` as today | S |
| Rust core | `coordinator.rs:357-374` | only set `t.branch = nc/<id>` in worktree mode | XS |
| Contracts | `packages/contracts/src/models.ts` + `bridge.ts` | add `RunMode` schema + `runMode` on the `Task`/create contract (mirror serde) | S |
| Engine | n/a | no engine change (kind presets unaffected) | — |
| Web | new-task dialog (`apps/web/src/components/board/…` create flow) | a 2-way toggle "Run on `main`" / "Isolate in a worktree" at task creation, defaulting from a project setting | M |
| Web | `SettingsView.tsx:436-453` | add a per-project "default run mode" setting (sits next to the existing worktree section) | S |
| Settings (core) | `settings.rs:23-37`, `SettingsOverride`/`SettingsPatch` | optional `default_run_mode` (global + per-project override) so the dialog has a sensible default | S |

Guardrail: in `main` mode the dirty-base refusal (`coordinator.rs:417`) becomes a foot-gun (you *want* to edit the working tree) — relax it for `main` mode, keep it for `worktree` mode (you should never branch off a dirty base).

Switching/monitoring (port from AutoMaker, but lighter): Nightcore already has **one board** and shows the per-task branch chip (`Task.branch`). For v1, **do not** build AutoMaker's pinned-tab worktree switcher; instead group/filter the existing board by branch and keep the single board. The "active worktree" concept can be deferred — Nightcore's tasks already carry their own branch, so a per-task chip + a branch filter is enough. (Revisit tabs only if users run many parallel worktrees and want per-branch boards.)

### D2 — Build→commit→review→merge lifecycle fix (fixes Part B)

Ship this **independently and first** — it's a correctness bug, ~XS-S, no contract change.

| Tier | File(s) | Change | Size |
|---|---|---|---|
| Rust core | `sidecar.rs` `handle_build_completed` (between `:294` and `:302`) | **Option 1:** call `worktree::commit(project, task_id, "nightcore(wip): <title>")` before `dispatch_reviewer`, so `nc/<id>` HEAD advances and `git diff base...HEAD` / `rev-list base..HEAD` are non-empty | XS |
| Rust core | `sidecar.rs:525-541` `reviewer_prompt` | **Option 2:** make working-tree state authoritative — `git status --porcelain`, `git diff`, `git diff --cached`, read untracked files; treat `git diff base...HEAD` as supplementary | S |
| Rust core | `merge.rs:38-53` `commit_task` | reconcile with the new auto-commit: skip/amend when already WIP-committed instead of returning "nothing to commit" | XS |
| Rust core | `merge.rs:85` `worktree::merge` | optionally squash WIP commits on merge for clean history (or leave as-is) | XS |
| Engine | `kind-presets.ts` REVIEWER identity (`:43-58`) | no change required (per-run instructions live in the core prompt), but keep the reviewer's read-only tool denial intact | — |
| Tests | `worktree.rs` tests already cover commit/merge; add a sidecar/coordinator test asserting the gate sees the build's edit | S |

Both options are compatible; doing **Option 1 + Option 2** makes the gate correct regardless of whether a build commits, and makes the manual `commit_task`/`merge_task` operate on real history.

### D2.5 — Interaction with D1

In `main` run mode there is no worktree, so `verification_worktree` returns `None` and the gate is skipped today (`sidecar.rs:274`). Decide whether `main`-mode tasks should still be verified:
- Simplest: `main` mode = no automated gate (trust the user; they chose to edit main directly).
- Stricter: run the reviewer against working-tree state in the project root (requires Option 2's working-tree-aware prompt) — but **never** auto-commit/merge in `main` mode, since there's no branch to merge.

### Sequencing recommendation

1. **D2 first** (correctness; standalone PR; no contract churn).
2. **D1 core + contracts** (the `run_mode` field, default = current behavior to avoid surprises while the UI lands).
3. **D1 web** (the creation toggle + project default setting).
4. Defer AutoMaker's pinned-tab worktree switcher, configured-file copy, and PR integration to later milestones — they're nice-to-haves, not blockers for the two reported problems.

---

## Evidence index (quick reference)

Nightcore:
- Always-allocate: `apps/desktop/src-tauri/src/m2/coordinator.rs:339, 411-426`
- worktree primitives: `apps/desktop/src-tauri/src/m2/worktree.rs:26-38, 76-102, 107-124, 131-146, 153-172, 186-201`
- No opt-in: `task.rs:70-130, 174-187`; `settings.rs:23-37`
- Reviewer cwd + prompt: `sidecar.rs:439-443, 457-481, 515-520, 525-541`
- Build→gate (no commit): `sidecar.rs:260-311`
- Manual commit/merge: `merge.rs:37-53, 58-111`
- Web worktree settings only: `apps/web/src/components/settings/SettingsView/SettingsView.tsx:436-453`; build-kind copy: `apps/web/src/components/board/status.ts:144`

AutoMaker:
- WorkMode (3-way per-task): `apps/ui/src/components/views/board-view/shared/work-mode-selector.tsx:8, 22-41`; `libs/types/src/feature.ts:96`
- branchName→worktree at runtime: `apps/server/src/services/execution-service.ts:224-235`
- branch naming: `apps/ui/src/components/views/board-view/hooks/use-board-actions.ts:198-212`
- worktree path + create: `apps/server/src/routes/worktree/routes/create.ts:174-177, 263-266`
- working-tree-aware diff: `libs/git-utils/src/diff.ts:249-409`
- worktree switcher + active-worktree state: `apps/ui/src/components/views/board-view/worktree-panel/worktree-panel.tsx`; `apps/ui/src/store/app-store.ts:115-123, 307-310, 404, 1205-1219`
- pipeline/auto-merge/cleanup: `apps/server/src/services/pipeline-orchestrator.ts:73-159, 155-158, 579-631`; `apps/server/src/routes/worktree/routes/delete.ts:150-189`
