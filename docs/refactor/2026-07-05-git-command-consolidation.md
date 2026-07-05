# Refactor Plan — Consolidating Git & `gh` Command Usage

**Date:** 2026-07-05
**Agent:** kirei-refactor
**Scope:** Every surface that spawns `git` or `gh` (Rust core, Bun sidecar/engine, React web, scripts, CI) and the duplication between them. Goal: reduce duplication and make git logic easier to navigate, ideally via a dedicated package under `packages/`.
**Sibling:** kirei-arch is mapping the module-boundary / dependency-graph view of the same target — this doc stays in the code-smell / duplication / extraction lens.

---

## Summary

The headline finding is a **tier mismatch the user's framing needs to know up front**: essentially **100% of the `git`/`gh` subprocess logic lives in the Rust core** (`apps/desktop/src-tauri`). The TypeScript side (`packages/`, `apps/sidecar`, `apps/web`) spawns **no** `git` or `gh` processes at all. `packages/` is a TS/Bun workspace, so **a `packages/@nightcore/git` package cannot serve the Rust core** — creating one for the runners would be over-abstraction with almost nothing to hold.

The real, high-value consolidation is a **Rust-side `src/git/` module** inside the single `nightcore` crate. The good news: the security-critical env-isolation chokepoint (`platform::git_command`) is already a single seam and the `worktree/` module already has a clean `git()`/`git_with_deadline()`/`git_status_success()` runner trio — but those helpers are **module-private to `worktree/`**, so ~16 other call sites re-roll the same spawn+status+parse boilerplate directly. The consolidation is mostly "promote the trio into a shared `git::` module and delete the copies", **not** "invent a new abstraction."

Top priorities:
1. **Promote the bounded/unbounded git runners out of `worktree/mod.rs`** into `src/git/run.rs` so every module shares them (kills a verbatim `git_stdout` triplicate + ~16 ad-hoc re-rolls). Chokepoint stays exactly where it is.
2. **Fold the 13-site `gh` call boilerplate** (`probe_gh` → `run_gh_bounded` → status-check → `map_gh_failure`) into a single `run_gh_checked` / `run_gh_json<T>` helper.
3. **Extract shared porcelain parsers** (`--numstat`, `rev-list --left-right`, `ls-files -z`, `status --porcelain`) so `diff_budget` / `ratchet` / `insight` / `analysis` stop re-parsing.

**Do NOT** scatter or duplicate `platform::git_command`; it is the git-env isolation seam and the injection-scan test asserts it neutralizes `core.fsmonitor`. Every proposed helper builds *on* it.

---

## Inventory — every git/gh spawn surface

### A. The chokepoint (keep, single seam)
| Location | What |
|----------|------|
| `apps/desktop/src-tauri/src/infra/platform.rs:158` | `git_command(repo)` — builds an env-isolated `git` Command: scrubs 11 `GIT_*` vars (`GIT_ENV_VARS_TO_CLEAR` :91), scrubs 11 exec/linker vectors (`GIT_EXEC_ENV_VARS_TO_CLEAR` :113), injects `-c core.fsmonitor=`/`core.sshCommand=`/`core.pager=cat`/`core.hooksPath=/dev/null` neutralizers (:135), sets `HUSKY=0`/`LC_ALL=C`/`GIT_TERMINAL_PROMPT=0`. **Security-critical. Do not touch its guarantees.** |
| `apps/desktop/src-tauri/src/infra/platform.rs:78` | `std_command(name)` — the generic resolved-Command builder that `gh` and `claude` spawns use. |
| `apps/desktop/src-tauri/src/infra/proc.rs:27` | `wait_with_deadline(child, deadline)` — shared kill-on-overrun reaper used by the bounded runners. |

### B. Rust — the clean `git` layer (already well-factored, but private)
`apps/desktop/src-tauri/src/worktree/`
| File | Git ops |
|------|---------|
| `mod.rs:87` `git()`, `:106` `git_with_deadline()`, `:153` `git_status_success()`, `:166` `refresh_index()`, `:173` `parse_left_right_count()` | The runner trio + shared parsers — **all module-private**, so nothing outside `worktree/` can reuse them. |
| `branch.rs` | `base_branch`, `current_branch` (`rev-parse --abbrev-ref HEAD`), `fetch_base`, `merge_ff_only`, `push_branch`, `delete_branch_named`, `list_branches`, `remote_url`, `try_ahead_of_upstream` (`for-each-ref …track`) |
| `commit.rs` | `stage_all` (`add -A`), `has_staged_changes` (`diff --cached --quiet`), `staged_diff`, `commit` |
| `diff.rs:24` | `diff_numstat` (`diff --numstat` parser — `pub(super)`, i.e. private), `base_diff`, `worktree_diff` |
| `status.rs` | `is_worktree_clean` (`status --porcelain`), `worktree_status`, `list_worktree_statuses` (`rev-list --left-right --count`) |
| `merge.rs:15` `merge_branch`, `:102` `merge_preview` (`merge-tree --write-tree`), `:188` `detect_merge_conflicts` | The only mutating merge path (`merge` only, abort-not-force). `:188` calls `git_command` directly (documented exit-code specialization). |
| `lifecycle.rs` | `allocate`/`remove`/`reconcile` (`worktree add`/`remove --force`/`prune`) — **security-sensitive dir ops + `is_under` escape guard.** |
| `path.rs` | `validate_ref`, `branch_name`, `worktree_path` — **pure**, unit-tested, no I/O. |
| `provision.rs` | `provision_deps` |

### C. Rust — direct `platform::git_command` calls that BYPASS the trio (the smell)
Each re-implements "spawn → check `status.success()` → `from_utf8_lossy(stdout).trim()` → parse":
| Location | Git op | Duplicate of |
|----------|--------|--------------|
| `analysis/injection_scan.rs:127` | `ls-files -z` + null-split | ← ls-files cluster |
| `analysis/repo_map.rs:89` | `ls-files -z` + null-split | verbatim ls-files dup |
| `workflow/ratchet.rs:156` | `ls-files -z -- *.ts *.tsx` | verbatim ls-files dup |
| `workflow/diff_budget.rs:144` `fn git_stdout` | `merge-base`, `diff --numstat --no-renames` | ← `git_stdout` triplicate + numstat re-parse |
| `workflow/contract_budget.rs:119` `fn git_stdout` | generic | **verbatim** `git_stdout` copy |
| `workflow/anti_gaming/sweep.rs:74` `fn git_stdout` | generic | **verbatim** `git_stdout` copy |
| `workflow/pr_fix/conflicts.rs:39,69,115,126` | `merge --no-edit`, `diff --name-only --diff-filter=U`, `rev-parse --verify MERGE_HEAD`, `merge --abort` | ad-hoc |
| `workflow/pr_fix/checkout.rs:278,291` | branch/checkout ops | ad-hoc |
| `workflow/pr_fix/comment.rs:81` | git read | ad-hoc |
| `sidecar/insight.rs:50` `fn changed_files` | `diff`/`ls-files` file listing | overlaps analysis + worktree/diff |
| `commands/project.rs:79` `fn current_branch` | `rev-parse --abbrev-ref HEAD` | **re-impl of `worktree::current_branch`** |
| `commands/project.rs:266` `git_init` | `init` | ad-hoc (fine as leaf) |

### D. Rust — the `gh` seam (GitHub CLI)
Seam: `apps/desktop/src-tauri/src/workflow/pr/gh.rs` — `GH_BINARY` (:12), `GhOutput` (:16), `probe_gh` (:30), `map_gh_failure` (:41), `run_gh_bounded` (:55). Well-deduplicated at the *primitive* level. **13 call sites** repeat the same 4-step orchestration on top of it:
`pr/create.rs:367,435` · `pr/viewer.rs:56` · `pr_list.rs:188` · `pr_changed_files.rs:106` · `pr_status/view.rs:201` · `pr_comments/fetch.rs:226` · `pr_review_post/diff.rs:57,70,115` · `pr_review_post/post.rs:82` · `pr_fix/ci.rs:44` · `pr_fix/comment.rs:105` · `pr_fix/checkout.rs:217`.
PR `--json` field constants are also fragmented across files: `pr_changed_files.rs:25 PR_FILES_FIELDS`, `pr_list.rs:25 PR_LIST_FIELDS`, `pr_status/view.rs:26 PR_VIEW_FIELDS`.

### E. Rust — `claude -p` seam (git-adjacent text-gen)
`workflow/claude_oneshot.rs:45` `run_claude_with` — a **third** bounded-subprocess runner (feed stdin on a thread, drain stdout, poll-with-timeout, kill on overrun). Consumed by `workflow/commit_msg.rs` (commit messages) and `workflow/pr_msg.rs` (PR bodies). Shares `cap` (:137) and `strip_code_fence` (:151), which are already deduplicated. Least-privilege arg-building is bespoke and should stay so.

### F. TypeScript / web / scripts — NO git or gh spawns
- `packages/`, `apps/sidecar`, `apps/web`: **zero** `git`/`gh` subprocess spawns (verified by grep for `Bun.spawn`/`execa`/`child_process`/`spawnSync`/`$\``).
- The only TS git *knowledge*: `packages/engine/src/policy/tool-deny-policy.ts:318,326,487` — pure git **command classification** (`isGit`, `isForcePush`, `isHardReset`) that reasons about *the agent's* git commands for the deny policy. It does not spawn git.
- `packages/shared/src/which.ts` — generic `which`-style binary resolution (`execFileSync`), not git-specific.
- `apps/web`: `BranchPicker`, `WorktreeView`, PR views, worktree settings — **presentation only**; consume git data through the Tauri bridge.
- `scripts/headless-harness.ts` (scratch-repo dogfood), `tools/*`, `.github/workflows/ci.yml:134` (`git diff --exit-code` codegen guard) — git for **test/CI infra**. Out of scope for a git-logic package.

---

## Duplication to Consolidate

### 1. Bounded subprocess runner (thread-drain + deadline + kill) — 3 near-identical copies
**Files:** `worktree/mod.rs:106` `git_with_deadline` · `workflow/pr/gh.rs:55` `run_gh_bounded` · `workflow/claude_oneshot.rs:45` `run_claude_with`
**What it does:** spawn a child, feed stdin from a detached thread, drain stdout+stderr on threads (so neither pipe fills and blocks), wait under a wall-clock deadline via `proc::wait_with_deadline`, kill on overrun. The comments literally cross-reference "the claude_oneshot discipline."
**Extract to:** `src/git/run.rs` — one `run_bounded(command, stdin, deadline, timeout_msg) -> BoundedOutput` core, parameterized by the pre-built `Command` (so `git`/`gh`/`claude` each pass their own env-configured Command). Chokepoint unchanged.

### 2. `fn git_stdout(dir, args) -> Option<String>` — verbatim triplicate
**Files:** `workflow/diff_budget.rs:144` · `workflow/contract_budget.rs:119` · `workflow/anti_gaming/sweep.rs:74` (byte-for-byte the same, modulo an empty-string check). Plus the private `worktree/mod.rs:87 git()` and ad-hoc inline versions in `commands/project.rs`, `sidecar/insight.rs`, `workflow/ratchet.rs`.
**Extract to:** `src/git/run.rs` — a single public `git_stdout` / `git_output` used everywhere.

### 3. `git ls-files -z` invoke + null-split — 3 copies
**Files:** `analysis/injection_scan.rs:127` · `analysis/repo_map.rs:89` · `workflow/ratchet.rs:156`
**Extract to:** `src/git/query.rs` — `list_tracked_files(root, pathspec) -> Vec<PathBuf>` (one env-isolated `ls-files -z` + parse).

### 4. `current_branch` (`rev-parse --abbrev-ref HEAD`) — cross-module re-impl
**Files:** `worktree/branch.rs:current_branch` (public) vs `commands/project.rs:79` (private re-implementation).
**Fix:** delete the `project.rs` copy; call the promoted `git::query::current_branch`.

### 5. `--numstat` parsing — 2 implementations
**Files:** `worktree/diff.rs:24 diff_numstat` (proper, but `pub(super)`) vs `workflow/diff_budget.rs` inline numstat parse.
**Extract to:** `src/git/parse.rs` — one `parse_numstat` reused by both.

### 6. `gh` call orchestration (probe → run → status-check → map) — 13 copies
**Files:** the 13 sites in section D.
**Extract to:** `src/git/gh.rs` — `run_gh_checked(dir, subcmd, args, …) -> Result<GhOutput>` (folds probe + status-check + `map_gh_failure`) and a thin `run_gh_json<T: DeserializeOwned>(…) -> Result<T>` for the `--json` readers. Centralize the `PR_*_FIELDS` constants there too.

---

## Abstractions to Add
### A shared `src/git/` module (Rust, inside the existing `nightcore` crate)
**Currently:** git plumbing is split across `worktree/` (private helpers), `workflow/pr*` (`gh` seam), `workflow/{diff_budget,contract_budget,ratchet,anti_gaming}` (copy-pasted `git_stdout`), `analysis/*` (`ls-files`), `commands/project.rs`, `sidecar/insight.rs`.
**Should be:**
- `src/git/run.rs` — the runner trio (`git_output`/`git_stdout`, `git_bounded`, `git_status_success`) + the shared `run_bounded` core (also backing `gh`/`claude`). Builds on `platform::git_command` / `std_command`.
- `src/git/parse.rs` — pure porcelain parsers: `parse_numstat`, `parse_left_right_count`, `parse_for_each_ref_track`, `parse_ls_files_z`, `parse_status_porcelain`. Unit-tested, no I/O.
- `src/git/query.rs` — small reusable reads: `current_branch`, `list_tracked_files`, `changed_files` (dedups `project.rs`/`insight.rs`/`analysis`).
- `src/git/gh.rs` — the `gh` seam moved from `workflow/pr/gh.rs` + `run_gh_checked`/`run_gh_json` + centralized field constants.
- `worktree/` keeps its worktree-*specific* ops (lifecycle, path guards, merge posture) but calls `git::run`/`git::parse` instead of private copies.

## Abstractions to Remove / NOT Add
### Do NOT create `packages/@nightcore/git` (TS) for the runners
**Location:** proposed `packages/git`.
**Why:** `packages/` is TS/Bun; the runners are Rust and cannot cross the tier. There is no TS git-subprocess code to move into it — it would be an empty abstraction. The one TS git concern (`tool-deny-policy.ts` classification, ~3 pure helpers) is too small to justify a package and is tightly coupled to the deny policy; leave it in `@nightcore/engine`. Only revisit a tiny *pure* `@nightcore/git-spec` (no spawning) if the web ever needs to classify git commands too.

---

## Files to Split
No single git file is oversized enough to force a split — the `worktree/` tree is already decomposed into small cohesive modules. The largest git-touching file is `workflow/pr/create.rs` (1028 lines incl. tests), which is a PR-flow concern rather than raw git plumbing; leave it unless kirei-arch flags it. The consolidation here is *extraction of shared helpers*, not file-splitting.

---

## Implementation Order
Refactors have dependencies — do them in this order:
1. **Create `src/git/parse.rs`** (pure parsers). Zero behavior change, fully unit-testable. Safe first step; nothing depends on it yet.
2. **Create `src/git/run.rs`**: move `git()`/`git_with_deadline()`/`git_status_success()` out of `worktree/mod.rs`, extract the shared `run_bounded` core. Point `worktree/` at it. Behavior-preserving.
3. **Point `run_gh_bounded` + `run_claude_with` at the shared `run_bounded` core** (drain/deadline mechanics only; keep each binary's env + arg-building distinct).
4. **Add `src/git/gh.rs::run_gh_checked`/`run_gh_json`** and migrate the 13 `gh` call sites; centralize `PR_*_FIELDS`. Multi-file, ordering matters.
5. **Delete the 3 `git_stdout` copies + `project.rs::current_branch`** and route through `git::run`/`git::query`. Mechanical.
6. **Route `analysis` `ls-files` + `ratchet` + `insight` through `git::query`.** Mechanical.
7. *(Optional, later)* Only consider splitting `git` into a separate Rust workspace crate if compile-time isolation or reuse actually demands it — the desktop app is currently a **single** `nightcore` crate, so a module is the right granularity now.

---

## Effort Estimates
| Change | Effort | Risk | Value |
|--------|--------|------|-------|
| Extract `git::parse` (pure parsers) | S | Low | Med |
| Promote runner trio → `git::run` | M | Med | High |
| Unify 3 bounded runners on one core | M | Med | High |
| `run_gh_checked`/`run_gh_json` + migrate 13 sites | M | Med | High |
| Delete `git_stdout` triplicate + `current_branch` dup | S | Low | High |
| Route ls-files/insight through `git::query` | S | Low | Med |
| Create `packages/git` (TS) | — | — | **Negative — do not do** |
| Split `git` into its own Rust crate | L | Med | Low (defer) |

---

## What NOT to Refactor
- **`platform::git_command` and the env-isolation constants** (`GIT_ENV_VARS_TO_CLEAR`, `GIT_EXEC_ENV_VARS_TO_CLEAR`, `GIT_CONFIG_NEUTRALIZERS`). This is the single security seam. `git::run` must build on it; introducing any raw `Command::new("git")` is a regression (the `injection_scan` test asserts `core.fsmonitor` neutralization).
- **`worktree/lifecycle.rs` dir ops + `path.rs::is_under` escape guard.** Workspace confinement is security-critical; do not fold path-safety into a generic runner.
- **`worktree/merge.rs` abort-not-force posture** — intentional; leave it.
- **`claude_oneshot.rs` least-privilege arg-building** (`--disallowed-tools`, arg-order gotcha) — share only the drain/deadline mechanics, keep the privilege posture bespoke.
- **`commands/project.rs::git_init`** and other one-line leaf spawns — fine as-is once they use the shared runner; not worth bespoke abstraction.
- **A TS `packages/git` package for subprocess logic** — see "Abstractions to Remove."

---

## Note for kirei-arch (other lens)
- The `gh` seam lives under `workflow/pr/` while the `git` seam lives under `worktree/`, yet both are "external VCS process" concerns — that split is a **module-boundary** question (should a `git::` module own both, and should `worktree`/`workflow` depend *down* onto it?) more than a duplication one. Flagging for the dependency-graph lens.
- `sidecar/insight.rs` and `analysis/*` reaching for `platform::git_command` directly means the *git seam* currently has consumers in `worktree`, `workflow`, `analysis`, `sidecar`, and `commands` — a fan-in worth drawing on the dependency graph.
