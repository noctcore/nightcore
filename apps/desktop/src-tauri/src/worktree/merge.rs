//! Merge integration, the read-only merge preview, and conflict detection.
//!
//! [`merge_branch`] is the only mutating path — `git merge` only (never
//! `--force`/reset), aborting on a real conflict so the base tree is never left
//! forced. [`merge_preview`] and [`detect_merge_conflicts`] compute the same
//! outcome WITHOUT touching the working tree (`git merge-tree --write-tree`).

use std::path::Path;

use super::diff::{diff_numstat, DiffFileStat};
use super::status::is_worktree_clean;
use super::{git, parse_left_right_count};
use crate::git::validate_ref;

/// Merge `branch` into `base` in the project's main checkout — ONLY via `git merge`
/// (never `--force`/reset). Refuses a dirty base. A genuine conflict (the merge left
/// unmerged paths in the index) is aborted via `merge --abort` and reported as
/// `Ok(MergeOutcome::Conflict)` with a clean tree — but if the abort itself fails the
/// tree is stuck mid-merge, so we return `Err` rather than falsely claiming a clean
/// conflict. Any OTHER merge failure (nonexistent branch, unrelated histories, …)
/// starts no merge and is surfaced as `Err`, never mislabeled a conflict.
/// `branch`/`base` are resolved by the caller (the task's stored branch / base,
/// defaulting to `nc/<taskId>` off the project's current branch).
pub fn merge_branch(project_path: &Path, branch: &str, base: &str) -> Result<MergeOutcome, String> {
    // Reject a branch/base git would read as an OPTION or that is not a legal ref
    // before either reaches a `git` argument list.
    validate_ref(base)?;
    validate_ref(branch)?;
    // The base branch must be checked out to receive the merge. Refuse if the main
    // tree is dirty so we never merge over uncommitted work.
    if !is_worktree_clean(project_path)? {
        return Err("base working tree is dirty; commit or stash before merging".to_string());
    }
    git(project_path, &["checkout", "--end-of-options", base])?;

    match git(
        project_path,
        &["merge", "--no-edit", "--end-of-options", branch],
    ) {
        Ok(_) => Ok(MergeOutcome::Merged),
        Err(merge_err) => {
            // A merge failure is only a *conflict* when it left unmerged paths in the
            // index. Anything else (nonexistent branch, unrelated histories, …)
            // started no merge — surface it as an error, not a misleading "conflict".
            if !has_unmerged_paths(project_path) {
                return Err(format!(
                    "git merge {branch} into {base} failed: {merge_err}"
                ));
            }
            // A real conflict: abort so the base tree is left clean, never forced. If
            // the abort itself fails the tree is stuck mid-merge (dirty) — do NOT
            // report a clean conflict; return the error so the caller/UI knows the
            // base needs manual recovery.
            git(project_path, &["merge", "--abort"]).map_err(|abort_err| {
                format!(
                    "merge conflict integrating {branch} into {base}, and `git merge --abort` \
                     failed — the base tree is left mid-merge: {abort_err}"
                )
            })?;
            Ok(MergeOutcome::Conflict)
        }
    }
}

/// Whether the repo index currently holds unmerged (conflicted) paths — the signal
/// that a failed `git merge` is a genuine content conflict rather than a hard error
/// (nonexistent branch, unrelated histories, …). `git ls-files --unmerged` lists a
/// stage entry per conflicted path, so empty output means no conflict is in flight.
fn has_unmerged_paths(repo: &Path) -> bool {
    git(repo, &["ls-files", "--unmerged"])
        .map(|out| !out.is_empty())
        .unwrap_or(false)
}

/// The result of a [`merge_branch`] attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeOutcome {
    /// The branch integrated cleanly into the base.
    Merged,
    /// A conflict was detected; the merge was aborted (not forced).
    Conflict,
}

/// The outcome of pulling `base` INTO a worktree branch ([`update_from_base`]).
#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, ts(export, export_to = "UpdateFromBaseStatus.ts"))]
pub enum UpdateFromBaseStatus {
    /// The worktree branch already contained every base commit — nothing to do.
    UpToDate,
    /// Base was merged into the worktree branch cleanly.
    Updated,
    /// Merging base conflicted; the merge was aborted (the worktree is left clean).
    Conflict,
}

/// Pull `base` INTO a worktree branch — the "Update from base" action (T13). Merges the
/// current `base` into the checked-out `nc/<taskId>` branch INSIDE `worktree_dir`, so a
/// branch cut before a base-only commit (the documented silent-revert incident class —
/// e.g. a security fix landed on base after the branch forked) stops reverting it on the
/// eventual merge. Only `git merge` (never `--force`/reset); a genuine conflict is
/// aborted (`merge --abort`) and reported as `Conflict` with a clean worktree, exactly
/// like [`merge_branch`]. Refuses a dirty worktree so uncommitted work is never merged
/// over. Distinct from [`super::branch::merge_ff_only`], which fast-forwards the MAIN
/// checkout onto origin — this operates entirely inside the isolated worktree.
pub fn update_from_base(worktree_dir: &Path, base: &str) -> Result<UpdateFromBaseStatus, String> {
    validate_ref(base)?;
    if !is_worktree_clean(worktree_dir)? {
        return Err(
            "this worktree has uncommitted changes; commit or discard them before updating from base"
                .to_string(),
        );
    }
    // Nothing to pull when the branch already contains every base commit (`base...HEAD`
    // left-count == commits on base not in the branch).
    let range = format!("{base}...HEAD");
    let (behind, _ahead) = git(
        worktree_dir,
        &[
            "rev-list",
            "--left-right",
            "--count",
            "--end-of-options",
            &range,
        ],
    )
    .ok()
    .and_then(|s| parse_left_right_count(&s))
    .unwrap_or((0, 0));
    if behind == 0 {
        return Ok(UpdateFromBaseStatus::UpToDate);
    }
    match git(
        worktree_dir,
        &["merge", "--no-edit", "--end-of-options", base],
    ) {
        Ok(_) => Ok(UpdateFromBaseStatus::Updated),
        Err(merge_err) => {
            // Only a genuine content conflict (unmerged paths) is aborted-and-reported;
            // any other failure started no merge and is surfaced as an error.
            if !has_unmerged_paths(worktree_dir) {
                return Err(format!(
                    "git merge {base} into the worktree failed: {merge_err}"
                ));
            }
            git(worktree_dir, &["merge", "--abort"]).map_err(|abort_err| {
                format!(
                    "merge conflict pulling {base} into the worktree, and `git merge --abort` \
                     failed — the worktree is left mid-merge: {abort_err}"
                )
            })?;
            Ok(UpdateFromBaseStatus::Conflict)
        }
    }
}

/// The outcome of a read-only merge preview.
#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "MergePreviewStatus.ts"))]
pub enum MergePreviewStatus {
    /// Branch is level with base — nothing to merge.
    UpToDate,
    /// Branch is ahead of base and merges cleanly.
    Ready,
    /// Branch and base diverged but still merge cleanly.
    Diverged,
    /// Merging would conflict (the merge is NOT performed — preview only).
    Conflicts,
}

/// A read-only preview of merging `branch` into `base`: status, the files that would
/// conflict, the changed-file stats, and ahead/behind counts. Computed without
/// touching the working tree (`git merge-tree --write-tree`), so it is safe to call
/// freely (Aperant's merge-preview, automaker's multi-layer conflict detection).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "MergePreview.ts"))]
pub struct MergePreview {
    /// The merge status (up-to-date / ready / diverged / conflicts).
    pub status: MergePreviewStatus,
    /// The branch being previewed.
    pub branch: String,
    /// The base branch the merge would target.
    pub base: String,
    /// Files that would conflict. Empty when none; also empty in the rare "unknown"
    /// case (the `status` carries the conflict signal regardless).
    pub conflict_files: Vec<String>,
    /// Per-file change stats of `base...branch`.
    pub files: Vec<DiffFileStat>,
    /// Total added lines across `files`.
    pub additions: u32,
    /// Total deleted lines across `files`.
    pub deletions: u32,
    /// Commits the branch is ahead of base.
    pub ahead: u32,
    /// Commits the branch is behind base.
    pub behind: u32,
}

/// Preview merging `branch` into `base` — READ-ONLY (never mutates the working tree).
pub fn merge_preview(project_path: &Path, branch: &str, base: &str) -> MergePreview {
    let range = format!("{base}...{branch}");
    let (behind, ahead) = git(
        project_path,
        &[
            "rev-list",
            "--left-right",
            "--count",
            "--end-of-options",
            &range,
        ],
    )
    .ok()
    .and_then(|s| parse_left_right_count(&s))
    .unwrap_or((0, 0));
    let (files, additions, deletions) = diff_numstat(project_path, &range);
    let (status, conflict_files) = match detect_merge_conflicts(project_path, base, branch) {
        ConflictDetection::Conflicts(f) => (MergePreviewStatus::Conflicts, f),
        _ => {
            let status = if ahead == 0 {
                MergePreviewStatus::UpToDate
            } else if behind > 0 {
                MergePreviewStatus::Diverged
            } else {
                MergePreviewStatus::Ready
            };
            (status, Vec::new())
        }
    };
    MergePreview {
        status,
        branch: branch.to_string(),
        base: base.to_string(),
        conflict_files,
        files,
        additions,
        deletions,
        ahead,
        behind,
    }
}

/// Read-only conflict detection result.
enum ConflictDetection {
    /// The merge applies cleanly.
    Clean,
    /// The merge conflicts; the named files are unmergeable.
    Conflicts(Vec<String>),
    /// Could not be determined (old git without `--write-tree`, or a bad ref).
    Unknown,
}

/// Detect whether merging `branch` into `base` conflicts, WITHOUT touching the tree,
/// via `git merge-tree --write-tree --name-only` (git ≥ 2.38). Exit 0 = clean, exit
/// 1 = conflicts (stdout lists the files after the tree OID), anything else (or an
/// old git lacking the flag) = unknown.
fn detect_merge_conflicts(project_path: &Path, base: &str, branch: &str) -> ConflictDetection {
    let Ok(out) = crate::platform::git_command(project_path)
        .args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--end-of-options",
            base,
            branch,
        ])
        .output()
    else {
        return ConflictDetection::Unknown;
    };
    if out.status.success() {
        return ConflictDetection::Clean;
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.contains("usage:") || stderr.contains("unknown option") || stderr.contains("error:") {
        return ConflictDetection::Unknown;
    }
    if out.status.code() == Some(1) {
        let stdout = String::from_utf8_lossy(&out.stdout);
        // `<tree-oid>\n<conflicted file>…\n\n<informational messages>`: take the
        // file-name section up to the first blank line.
        let files: Vec<String> = stdout
            .lines()
            .skip(1)
            .take_while(|l| !l.trim().is_empty())
            .map(|l| l.trim().to_string())
            .collect();
        return ConflictDetection::Conflicts(files);
    }
    ConflictDetection::Unknown
}
