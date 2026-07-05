//! The `conflicts` fix kind's git plumbing: merge the PR's base into its head
//! checkout, classify the outcome (clean / already up to date / conflicted),
//! and validate an agent's resolution before the auto-commit.
//!
//! Safety posture (the PR-arc rules): the base ref is `validate_ref`-validated
//! and addressed by its VERBATIM qualified remote-tracking name
//! (`refs/remotes/origin/<base>` — the `origin/<base>` shorthand is shadowable
//! by a hostile local branch), every ref-taking argv adds `--end-of-options`,
//! and nothing here ever resets or force-pushes. A failed/cancelled conflicts
//! fix aborts its in-progress merge (best-effort) so the checkout is never left
//! wedged mid-merge behind the user's back.

use std::path::Path;

use crate::worktree::validate_ref;

/// What `git merge refs/remotes/origin/<base>` did to the checkout.
#[derive(Debug, PartialEq)]
pub(super) enum MergeOutcome {
    /// The merge committed cleanly — there is a merge commit to push and no
    /// session to run.
    Clean,
    /// The branch already contains the base — nothing to resolve, nothing to
    /// push; the command refuses (the PR isn't actually conflicted).
    AlreadyUpToDate,
    /// The merge stopped on conflicts: the named files carry conflict markers
    /// and the checkout sits mid-merge (MERGE_HEAD present) — the fix session's
    /// job. Never empty.
    Conflicted(Vec<String>),
}

/// Merge the base branch's remote-tracking ref into the checkout at `dir`,
/// classifying the outcome. On a non-conflict merge failure (dirty tree, an
/// unrelated in-progress merge, …) the merge is aborted best-effort and the
/// error surfaces verbatim.
pub(super) fn merge_base_into(dir: &Path, base: &str) -> Result<MergeOutcome, String> {
    validate_ref(base)?;
    let remote_ref = format!("refs/remotes/origin/{base}");
    let out = crate::platform::git_command(dir)
        .args(["merge", "--no-edit", "--end-of-options", &remote_ref])
        .output()
        .map_err(|e| format!("failed to run git (is `git` on PATH?): {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if out.status.success() {
        if stdout.contains("Already up to date") {
            return Ok(MergeOutcome::AlreadyUpToDate);
        }
        return Ok(MergeOutcome::Clean);
    }
    let conflicted = unmerged_paths(dir)?;
    if conflicted.is_empty() {
        // Not a conflict stop — a real merge failure. Abort so the checkout is
        // not left mid-merge, then surface git's own explanation.
        abort_merge_best_effort(dir);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let detail = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        return Err(format!("`git merge` failed: {detail}"));
    }
    Ok(MergeOutcome::Conflicted(conflicted))
}

/// The checkout's unmerged (conflicted) paths — `git diff --name-only
/// --diff-filter=U`, one path per line.
pub(super) fn unmerged_paths(dir: &Path) -> Result<Vec<String>, String> {
    let out = crate::platform::git_command(dir)
        .args(["diff", "--name-only", "--diff-filter=U"])
        .output()
        .map_err(|e| format!("failed to run git (is `git` on PATH?): {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// Whether a line opens or closes a git conflict hunk. Git always writes the
/// seven-char runs at column 0; the mid-hunk `=======` separator is deliberately
/// NOT matched (it appears legitimately, e.g. under Markdown setext headings).
fn is_conflict_marker(line: &str) -> bool {
    line.starts_with("<<<<<<<") || line.starts_with(">>>>>>>")
}

/// The subset of `files` whose working-tree content still carries conflict
/// markers — the pre-commit validation for a `conflicts` fix (the auto-commit's
/// `git add -A` would otherwise happily stage half-resolved files as
/// "resolved"). Unreadable files count as unresolved (fail-closed: a file the
/// agent deleted mid-merge is a resolution git will surface, not this scan's
/// call to wave through).
pub(super) fn files_with_markers(dir: &Path, files: &[String]) -> Vec<String> {
    files
        .iter()
        .filter(|f| match std::fs::read_to_string(dir.join(f)) {
            Ok(content) => content.lines().any(is_conflict_marker),
            // Missing file = the agent resolved by deletion; `git add -A` +
            // commit handles that legitimately. Only a READ error on an
            // existing file is treated as unresolved.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => true,
        })
        .cloned()
        .collect()
}

/// Whether the checkout sits mid-merge (MERGE_HEAD resolves) — the
/// cancel/failure paths only abort when a merge is actually in progress.
pub(super) fn merge_in_progress(dir: &Path) -> bool {
    crate::platform::git_command(dir)
        .args(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Best-effort `git merge --abort` — the cleanup for a cancelled/failed
/// `conflicts` fix, so the checkout is never left wedged mid-merge. A failure
/// is warned, never propagated (the fix is already terminal).
pub(super) fn abort_merge_best_effort(dir: &Path) {
    match crate::platform::git_command(dir)
        .args(["merge", "--abort"])
        .output()
    {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            tracing::warn!(
                target: "nightcore::prfix",
                dir = %dir.display(),
                error = %String::from_utf8_lossy(&out.stderr).trim(),
                "git merge --abort failed; the checkout may still be mid-merge"
            );
        }
        Err(e) => {
            tracing::warn!(
                target: "nightcore::prfix",
                dir = %dir.display(),
                error = %e,
                "git merge --abort could not run"
            );
        }
    }
}
