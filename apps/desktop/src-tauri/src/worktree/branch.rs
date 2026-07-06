//! Branch resolution, deletion, and the branch-picker listing.
//!
//! Resolves the project's base branch ([`base_branch`]), best-effort branch
//! deletion with a self-protection guard ([`delete_branch_named`]), and the
//! local + remote-tracking branch list the create-dialog picker renders
//! ([`list_branches`]).

use std::path::Path;
use std::time::Duration;

use super::{git, git_status_success, git_with_deadline, parse_left_right_count};
use crate::git::validate_ref;

/// Wall-clock bound on the network-facing `git push`. Generous — a slow first
/// push of a big branch is legitimate — but finite, so a black-holed origin
/// can't pin the blocking thread (and the task's PR lease) forever.
const PUSH_TIMEOUT: Duration = Duration::from_secs(120);

/// Wall-clock bound on the network-facing `git fetch` behind [`fetch_base`]
/// (the pull-base fast-forward, PR arc phase 2). Same rationale as
/// [`PUSH_TIMEOUT`].
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

/// The fallback base branch when `HEAD` can't be resolved to a named branch (e.g.
/// detached HEAD). Used by [`base_branch`] and the reviewer's no-project fallback.
pub const DEFAULT_BASE_BRANCH: &str = "main";

/// The project's base branch: whatever `HEAD` points at in the main checkout
/// (`git rev-parse --abbrev-ref HEAD`). Falls back to `main` when it can't be
/// resolved (e.g. detached HEAD).
pub fn base_branch(project_path: &Path) -> String {
    git(project_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty() && b != "HEAD")
        .unwrap_or_else(|| DEFAULT_BASE_BRANCH.to_string())
}

/// The branch `HEAD` points at in `repo`, or `None` when it can't be resolved to
/// a NAMED branch (detached HEAD, a git failure). The STRICT sibling of
/// [`base_branch`] — no `main` fallback — for guards that must refuse rather
/// than guess (the pull-base fast-forward's wrong-branch check: a detached HEAD
/// must not read as "on main" when the base happens to be `main`).
pub fn current_branch(repo: &Path) -> Option<String> {
    git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .filter(|b| !b.is_empty() && b != "HEAD")
}

/// How many commits the worktree's checked-out branch carries that its UPSTREAM
/// does not (`git rev-list --left-right --count @{upstream}...HEAD`, the ahead
/// side) — the unpushed-commits count for the PR status card and the finalize
/// guard, computed LOCALLY (no network). FALLIBLE by design: an unresolvable
/// `@{upstream}` (never pushed, detached HEAD, or — the dangerous shape — a
/// remote-tracking ref pruned after GitHub auto-deleted the merged head branch)
/// is `Err`, never a silent `0`. A destructive caller (finalize's cleanup) must
/// treat `Err` as "cannot verify the branch was fully pushed" and REFUSE — the
/// old tolerant-zero read let a prune turn "1 unpushed commit" into "0" and
/// bypass the refusal, destroying the commit. The range is a fixed string (no
/// user input reaches the argv).
pub fn try_ahead_of_upstream(dir: &Path) -> Result<u32, String> {
    let out = git(
        dir,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    )?;
    parse_left_right_count(&out)
        .map(|(_behind, ahead)| ahead)
        .ok_or_else(|| format!("unparseable `git rev-list --count` output: {out}"))
}

/// Fetch `base` from `origin` into its remote-tracking ref (`git fetch origin
/// <base>`), bounded by [`FETCH_TIMEOUT`] — the network half of the pull-base
/// fast-forward (PR arc phase 2). The ref is validated at ingestion AND fenced
/// from option parsing (`--end-of-options` before the positionals).
pub fn fetch_base(project_path: &Path, base: &str) -> Result<(), String> {
    validate_ref(base)?;
    git_with_deadline(
        project_path,
        &["fetch", "--end-of-options", "origin", base],
        FETCH_TIMEOUT,
        "timed out fetching from origin — check your network and try again",
    )
    .map(|_| ())
}

/// Fast-forward the checked-out branch to origin's `base` — `git merge
/// --ff-only`, NEVER a real merge: when the local base has diverged the command
/// fails and git's error surfaces verbatim (the abort-not-force philosophy; the
/// caller must never fall back to a merge commit). The caller has already
/// verified the root is clean and checked out on `base`; the ref is validated
/// here too (defence in depth) before it reaches the argv.
///
/// The merged ref is the FULLY-QUALIFIED remote-tracking ref
/// (`refs/remotes/origin/<base>`), never the `origin/<base>` shorthand: the
/// shorthand resolves by name precedence, so a hostile LOCAL branch or tag
/// literally named `origin/<base>` (a plain `git branch "origin/main" <sha>` —
/// creatable by any in-repo agent) would shadow the remote-tracking ref and
/// fast-forward the project root onto unreviewed commits. The qualified form is
/// a verbatim lookup and cannot be shadowed.
pub fn merge_ff_only(project_path: &Path, base: &str) -> Result<(), String> {
    validate_ref(base)?;
    let remote_ref = format!("refs/remotes/origin/{base}");
    git(
        project_path,
        &["merge", "--ff-only", "--end-of-options", &remote_ref],
    )
    .map(|_| ())
}

/// The URL of the `origin` remote, or `None` when the repo has no `origin` remote
/// (or the read fails). A read-only capability probe for the PR arc (design §3.1):
/// no remote ⇒ the Create PR surface is disabled honestly instead of failing on
/// click.
pub fn remote_url(repo: &Path) -> Option<String> {
    git(repo, &["remote", "get-url", "origin"])
        .ok()
        .filter(|url| !url.is_empty())
}

/// Push `branch` to `origin`, setting its upstream (`git push -u origin <branch>`).
/// Plain push only — NEVER `--force`: the abort-not-force philosophy extends to the
/// remote (PR arc, phase 1). Run from the task's worktree dir so config/credentials
/// resolve exactly as the user's own `git push` would there. Idempotent: re-pushing
/// an already-pushed branch is a no-op, so a failure between push and PR-create is
/// safely re-runnable. The ref is validated at ingestion AND fenced from option
/// parsing at the call site (`--end-of-options` before the positionals). The push
/// talks to the network, so it runs under a wall-clock deadline — a black-holed
/// origin errors out instead of pinning the blocking thread forever.
pub fn push_branch(dir: &Path, branch: &str) -> Result<(), String> {
    validate_ref(branch)?;
    git_with_deadline(
        dir,
        &["push", "-u", "--end-of-options", "origin", branch],
        PUSH_TIMEOUT,
        "timed out pushing to origin — check your network and try again",
    )
    .map(|_| ())
}

/// Whether `branch` is FULLY MERGED into `base` — its tip is an ancestor of
/// `base`, so `base` already contains every commit on `branch` and re-merging it
/// would be a no-op (`git merge-base --is-ancestor <branch> <base>`, exit 0 =
/// merged). Read-only. Used by refresh reconciliation to reclaim a worktree whose
/// branch already landed — e.g. a PR merged on the remote after `finalize` refused
/// to clean up, once the base has been pulled — with NOTHING to lose. Both refs
/// are validated + option-fenced. Conservative on the safe side: any unresolvable
/// ref (a missing branch, a git failure) reads as "not merged" so a spurious
/// removal can never happen.
pub fn is_branch_merged(project_path: &Path, branch: &str, base: &str) -> bool {
    if branch.is_empty() || base.is_empty() {
        return false;
    }
    if validate_ref(branch).is_err() || validate_ref(base).is_err() {
        return false;
    }
    git_status_success(
        project_path,
        &[
            "merge-base",
            "--is-ancestor",
            "--end-of-options",
            branch,
            base,
        ],
    )
}

/// Delete a specific `branch` (best-effort). Refuses to delete the project's current
/// base branch / `HEAD` — a safety guard (Aperant) so a bad or user-supplied branch
/// value can never delete the user's working branch. The guard matches on *identity*,
/// not one spelling (see [`resolves_to_base_or_head`]): a qualified ref
/// (`refs/heads/main`) or a case variant (`Main`, which `git branch -D` happily
/// deletes on the case-insensitive filesystems we target) can't slip past it. A
/// missing branch is a no-op.
pub fn delete_branch_named(project_path: &Path, branch: &str) -> Result<(), String> {
    if branch.is_empty() {
        return Ok(());
    }
    // Reject a branch git would read as an OPTION (leading `-`) or that is not a legal
    // ref before it reaches `rev-parse`/`branch -D`.
    validate_ref(branch)?;
    if resolves_to_base_or_head(project_path, branch) {
        return Err(format!(
            "refusing to delete branch {branch} — it resolves to the project's base branch"
        ));
    }
    if git_status_success(
        project_path,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            branch,
        ],
    ) {
        git(project_path, &["branch", "-D", "--end-of-options", branch])?;
    }
    Ok(())
}

/// True when `branch` denotes the project's base branch or `HEAD` under *any* spelling
/// that `git branch -D` would resolve to the same underlying ref — the last line of
/// defense against a bad or user-supplied branch value deleting the working branch.
///
/// Exact string equality on the short name (the original guard) is bypassable in two
/// ways we verified against real git:
/// - a differently-qualified but equivalent ref (`refs/heads/main` vs `main`), and
/// - on the case-insensitive filesystems Nightcore targets (macOS/Windows), a case
///   variant (`Main`) — `git branch -D Main` case-folds on the filesystem and deletes
///   `main`, so the guard *must* fold case too.
///
/// So we match on two axes, both ASCII-case-insensitively:
/// 1. the short name against `HEAD` and the resolved base branch (the fast, I/O-free
///    path that also catches case variants), and
/// 2. the fully-qualified refname of the candidate against `HEAD`'s (resolved via
///    `rev-parse --symbolic-full-name`), so `refs/heads/main` / `heads/main` are
///    rejected too. Falls through to `false` when either can't be resolved (e.g.
///    detached HEAD), leaving axis 1 as the guarantee.
fn resolves_to_base_or_head(project_path: &Path, branch: &str) -> bool {
    let base = base_branch(project_path);
    if branch.eq_ignore_ascii_case("HEAD") || branch.eq_ignore_ascii_case(&base) {
        return true;
    }
    match (
        symbolic_full_name(project_path, "HEAD"),
        symbolic_full_name(project_path, branch),
    ) {
        (Some(head_ref), Some(candidate_ref)) => candidate_ref.eq_ignore_ascii_case(&head_ref),
        _ => false,
    }
}

/// Resolve `reference` to its fully-qualified refname (`main` / `refs/heads/main` /
/// `HEAD` → `refs/heads/main`). `None` when it doesn't resolve to a ref (detached
/// HEAD, a non-existent name, or a git failure). `--verify` keeps the output to the
/// single resolved name (without it, `rev-parse` echoes `--end-of-options` as an
/// extra line).
fn symbolic_full_name(project_path: &Path, reference: &str) -> Option<String> {
    git(
        project_path,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--symbolic-full-name",
            "--end-of-options",
            reference,
        ],
    )
    .ok()
    .filter(|s| !s.is_empty())
}

/// One branch for the branch picker. Local branches carry upstream + ahead/behind
/// tracking; remote-tracking branches carry name only.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "BranchInfo.ts"))]
pub struct BranchInfo {
    /// Short branch name (`main`, `nc/abc`, or `origin/main` for a remote).
    pub name: String,
    /// Whether this is a remote-tracking branch (`refs/remotes/*`).
    pub is_remote: bool,
    /// Whether this is the currently checked-out branch in the project's main tree.
    pub is_current: bool,
    /// The upstream this local branch tracks (`origin/main`), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub upstream: Option<String>,
    /// Commits ahead of upstream (local branches with an upstream only).
    pub ahead: u32,
    /// Commits behind upstream.
    pub behind: u32,
}

/// List the project's branches — local (`refs/heads`) with upstream + ahead/behind,
/// then remote-tracking (`refs/remotes`, name only) — for the branch picker. Uses a
/// stable `for-each-ref` format under `LC_ALL=C`. Tolerant: a failed read yields an
/// empty list so the picker degrades to free-form branch entry.
pub fn list_branches(project_path: &Path) -> Vec<BranchInfo> {
    let mut branches = Vec::new();
    if let Ok(out) = git(
        project_path,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:track,nobracket)",
            "refs/heads",
        ],
    ) {
        for line in out.lines() {
            let mut f = line.split('\t');
            let name = f.next().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let is_current = f.next().map(|h| h.trim() == "*").unwrap_or(false);
            let upstream = f.next().filter(|s| !s.is_empty()).map(str::to_string);
            let (ahead, behind) = parse_track(f.next().unwrap_or(""));
            branches.push(BranchInfo {
                name,
                is_remote: false,
                is_current,
                upstream,
                ahead,
                behind,
            });
        }
    }
    if let Ok(out) = git(
        project_path,
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
    ) {
        for line in out.lines() {
            let name = line.trim().to_string();
            // Skip the symbolic `origin/HEAD` pointer — it is not a real branch.
            if name.is_empty() || name.ends_with("/HEAD") {
                continue;
            }
            branches.push(BranchInfo {
                name,
                is_remote: true,
                is_current: false,
                upstream: None,
                ahead: 0,
                behind: 0,
            });
        }
    }
    branches
}

/// Parse `git for-each-ref %(upstream:track,nobracket)` text (`"ahead 2, behind 1"`,
/// `"ahead 3"`, `"behind 4"`, `"gone"`, or empty) into `(ahead, behind)`.
fn parse_track(s: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in s.split(',') {
        let p = part.trim();
        if let Some(n) = p.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = p.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}
