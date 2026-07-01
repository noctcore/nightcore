//! Branch resolution, deletion, and the branch-picker listing.
//!
//! Resolves the project's base branch ([`base_branch`]), best-effort branch
//! deletion with a self-protection guard ([`delete_branch_named`]), and the
//! local + remote-tracking branch list the create-dialog picker renders
//! ([`list_branches`]).

use std::path::Path;

use super::{git, git_status_success};

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

/// Delete a specific `branch` (best-effort). Refuses to delete the project's current
/// base branch / `HEAD` — an exact-match safety guard (Aperant) so a bad or
/// user-supplied branch value can never delete the user's working branch. A missing
/// branch is a no-op.
pub fn delete_branch_named(project_path: &Path, branch: &str) -> Result<(), String> {
    if branch.is_empty() {
        return Ok(());
    }
    if branch == "HEAD" || branch == base_branch(project_path) {
        return Err(format!(
            "refusing to delete branch {branch} — it is the project's base branch"
        ));
    }
    if git_status_success(project_path, &["rev-parse", "--verify", "--quiet", branch]) {
        git(project_path, &["branch", "-D", branch])?;
    }
    Ok(())
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
