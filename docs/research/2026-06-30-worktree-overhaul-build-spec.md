# Worktree Overhaul — Build Spec (2026-06-30)

Grounded in the kirei-chain findings (`docs/chain/2026-06-30-worktree-integration-adopt-for-nightcore.md`)
and a full cross-tier mapping of nightcore + automaker + Aperant.

## Decisions (locked with the user)
- **Scope:** both a task-integrated **branch picker** AND a standalone **worktree manager**.
- **Conflicts:** safe abort-not-force default + clear conflict view with the conflicted-file list and
  manual-resolution guidance. **No AI auto-merge.**
- **Landing:** commit to `main` in small conventional slices as each gate goes green.

## Architecture constraints (must hold)
- Worktrees stay **task-scoped**: path = `<project>/.nightcore/worktrees/<taskId>`, branch defaults to
  `nc/<taskId>`. Reconcile keys orphan-pruning off `task_id` dirs. We do NOT introduce task-less worktrees.
  The "standalone manager" is a rich management surface over the existing per-task worktrees (+ a create
  entry that mints a task with a chosen branch/base).
- Git runs **only in Rust** (`worktree.rs`), never in the Bun engine.
- `merge` mutates the project's MAIN checkout but only via `git merge` (never `--force`/reset); aborts on
  conflict leaving a clean tree. A **preview must be read-only** (`git merge-tree`), never a trial checkout.
- All destructive ops stay guarded by `is_under(worktrees_base, dir)`.
- Contracts are codegen'd both ways: zod→Rust (`bun run codegen:contracts`) and Rust→TS via ts-rs
  (`cargo test`). Never hand-edit `generated.rs` / `apps/web/src/lib/generated/*`. Bump the hard-coded
  variant counts in `contracts/mod.rs` when adding wire variants. New Rust IPC struct exported to web →
  add to `ts_bindings.rs` export list + expected-files assertion.

## Backend slices (Rust; each its own commit, `cargo test` green between)

### B1 — git-env isolation + hardening  [no contracts]
- New `platform::git_command(repo: &Path) -> Command`: `std_command("git")`, `.current_dir(repo)`,
  `.env_remove` the 11 `GIT_*` vars (Aperant `GIT_ENV_VARS_TO_CLEAR`), `.env("HUSKY","0")`,
  `.env("LC_ALL","C")` (locale-stable parsing), `.env("GIT_TERMINAL_PROMPT","0")` (never hang on creds).
  Expose `GIT_ENV_VARS_TO_CLEAR: &[&str]` + unit test (membership + that PATH/HOME survive).
- Route `worktree.rs::git()` and `git_status_success()` through `git_command`.
- `worktree.rs::refresh_index(dir)` best-effort `update-index --refresh`; call at the top of
  `worktree_status` to kill stale-stat dirty false-positives.
- Robust `remove`: keep `worktree remove --force`; on failure, retry (linear backoff) then
  `fs::remove_dir_all` + `worktree prune` (Aperant cleanup pattern), still `is_under`-guarded.
- `delete_branch`: exact-match guard — never delete a branch equal to the resolved base branch / `HEAD`.

### B2 — richer WorktreeStatus  [ts-rs only → WorktreeInfo.ts]
- Add additive fields to `WorktreeStatus`: `behind_of_base: u32`, `changed_files: u32` (dirty file count),
  `has_conflict: bool` (a prior aborted/known conflict marker — derive from a lightweight check; default false).
- `worktree_status` computes them tolerantly (degrade to 0/false). `rev-list --left-right --count base...HEAD`
  for ahead/behind; `status --porcelain | wc` for changed_files.

### B3 — list_branches  [command + BranchInfo → BranchInfo.ts]
- `worktree::list_branches(project) -> Vec<BranchInfo>` via `for-each-ref` (local + remote), with
  `name, is_remote, is_current, upstream: Option<String>, ahead: u32, behind: u32`.
- `#[tauri::command] list_branches(app) -> Result<Vec<BranchInfo>, String>` (spawn_blocking), register in
  `lib.rs`, bridge wrapper `listBranches()` (tauriInvoke fallback `[]`).

### B4 — merge_preview  [command + MergePreview → MergePreview.ts]
- `worktree::merge_preview(project, branch, base) -> MergePreview` — READ-ONLY:
  - `git merge-tree --write-tree <base> <branch>` (or fallback `merge-tree <base> <branch>`) to detect
    conflicts WITHOUT touching the tree; multi-layer (exit code + `CONFLICT` text + unmerged paths) like
    automaker `merge-service.ts:136-226`, all under `LC_ALL=C`.
  - `git diff --numstat base...branch` → changed files + additions/deletions.
  - `rev-list --left-right --count base...branch` → ahead/behind (diverged when both > 0).
  - Fields: `status: MergePreviewStatus { Ready | Conflicts | Diverged | UpToDate }`, `conflict_files: Vec<String>`,
    `files: Vec<DiffFileStat>`, `additions`, `deletions`, `ahead`, `behind`. `conflict_files` empty-vs-unknown
    distinction preserved.
- `#[tauri::command] merge_preview(app, id, base: Option<String>)`; resolve task→project→branch.
- Register + ts-rs export + bridge wrapper `mergePreview(id, base?)`.

### B5 — worktree_diff  [command + WorktreeDiff/WorktreeDiffFile → *.ts]
- `worktree::worktree_diff(project, task_id, base) -> WorktreeDiff` — working-tree-inclusive: combine
  `diff --numstat base...HEAD` (committed) with `status --porcelain` (uncommitted) so the reviewer's
  "uncommitted edits exist" invariant holds. `WorktreeDiffFile { path, status: Added|Modified|Deleted|Renamed,
  additions, deletions }`, plus `summary`.
- `#[tauri::command] worktree_diff(app, id)`; register + ts-rs + bridge `worktreeDiff(id)`.

### B6 — custom branch + base at creation  [contracts: additive Task field + create_task args]
- `Task.base_branch: Option<String>` (serde additive; ts-rs to Task.ts). `branch` already exists.
- `create_task` gains `branch: Option<String>`, `base_branch: Option<String>` (additive command args),
  stored on the task. `build_new_task` threads them.
- `allocate` becomes branch/base-aware: new `allocate_branch(project, task_id, branch, base) -> PathBuf`
  (creates `branch` off `base` via `worktree add -b <branch> <dir> <base>`, or checks out existing branch).
  The existing `allocate` delegates with `branch_name(task_id)` + current HEAD for the default path
  (fully backward compatible). `cwd.rs::resolve_worktree` passes the task's stored branch/base.
- `merge` / `delete_branch` use the task's **stored** branch when present, else `nc/<taskId>` (thread the
  branch instead of always recomputing). Base resolution: task.base_branch → project base_branch.
- Base sync before create (best-effort, FF-only, non-fatal): if base has an upstream, `fetch` + FF;
  diverged → proceed on local (automaker `branch-sync-service` invariant). Keep it small + non-fatal.

### B7 — discard_worktree  [command]
- `#[tauri::command] discard_worktree(app, id) -> Result<(), String>` — safe discard distinct from task
  delete: `remove` (robust) then `delete_branch` (guarded), best-effort, `is_under`-guarded, single-flight
  via TaskLease. Emits `nc:task`. Bridge `discardWorktree(id)` (raw invoke, must reject).

## UI slices (web; folder-per-component, `bun run lint` + typecheck + tests green)

Foundation (me, before fan-out): bridge wrappers (B3–B7) + re-export generated types + a friendly
`parseGitError(raw) -> {title, detail}` helper in `@/lib`.

- **U1 BranchPicker** — combobox (pick existing / "Create \"x\"" / base selector); props-down, ahead/behind
  hints; seeds default base. Built on `Menu`/`Modal` primitives. (automaker `branch-autocomplete.tsx`)
- **U2** wire BranchPicker into `NewTaskForm` (only when WorkModePicker = worktree): branch + base → createTask.
- **U3 WorktreeManager** — standalone panel: list worktrees w/ rich badges (dirty count, ahead/behind,
  conflict) + per-row actions (View diff, Merge preview, Merge, Discard). Composes U4/U5/U6.
- **U4 MergePreviewDialog** — Ready/N-conflicts/Diverged/UpToDate banner + changed-files + ±counts +
  conflict-file list + manual-resolution guidance. Gates the merge button. (Aperant `MergePreviewSummary`/`WorkspaceStatus`)
- **U5 DiffViewDialog** — changed-files list, per-status colors, ± counts, empty state. (Aperant `DiffViewDialog`)
- **U6 DiscardDialog** — confirm + stats + consequence copy + error→retry. (Aperant `DiscardDialog`/`WorktreeCleanupDialog`)
- **U7** enhance `WorktreeSwitcher` badges (changed-file count, behind count, conflict dot + tooltip) and
  relax the `tabs.length <= 1` early-return so a single-worktree status still shows.
- **U8** route git errors through `parseGitError` → `toast.error` at every worktree action.

Wiring (me, after fan-out): barrels, `AppShell.hooks.ts` action handlers (useActionGuard + toast),
`Board`/`TaskDetail` props, manager entry point, fixtures, stories.

## Gates (run between slices / at the end)
- `cargo test` (= conformance + ts-rs regen) — Rust tier. `bun run test:rust` for full (compiles sidecar first).
- `bun run codegen:contracts` after any zod change; `--check` is the CI guard.
- `bun run --filter @nightcore/web typecheck`, `bun run lint` (eslint-plugin), `bun run lint:meta`,
  web vitest. `git diff --exit-code apps/web/src/lib/generated` must be clean (commit regenerated TS).
