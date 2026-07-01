//! Diff parsing: per-file `--numstat` stats and the worktree-vs-base file list.
//!
//! [`diff_numstat`] is shared with the merge preview ([`super::merge`]); the
//! working-tree-inclusive [`worktree_diff`] (committed + uncommitted + untracked)
//! feeds the reviewer/UI.

use std::path::Path;

use super::{git, refresh_index};

/// Per-file line-change counts for a diff range (`git diff --numstat`).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "DiffFileStat.ts"))]
pub struct DiffFileStat {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Parse `git diff --numstat <range>` into per-file stats + totals. Binary files
/// (`-\t-\tpath`) contribute `0/0`. Shared with the merge preview.
pub(super) fn diff_numstat(repo: &Path, range: &str) -> (Vec<DiffFileStat>, u32, u32) {
    // `--no-renames` so a rename is a clean Delete+Add pair (one path per row) rather
    // than git's `old => new` form, which would not key cleanly.
    let out = git(
        repo,
        &["diff", "--numstat", "--no-renames", "--end-of-options", range],
    )
    .unwrap_or_default();
    let mut files = Vec::new();
    let mut add_total = 0;
    let mut del_total = 0;
    for line in out.lines() {
        let mut f = line.splitn(3, '\t');
        let add = f.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let del = f.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let Some(path) = f.next().map(str::to_string).filter(|p| !p.is_empty()) else {
            continue;
        };
        add_total += add;
        del_total += del;
        files.push(DiffFileStat {
            path,
            additions: add,
            deletions: del,
        });
    }
    (files, add_total, del_total)
}

/// The change kind of a file in a worktree diff.
#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "DiffStatus.ts"))]
pub enum DiffStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

/// One changed file in a worktree diff vs base.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "WorktreeDiffFile.ts"))]
pub struct WorktreeDiffFile {
    pub path: String,
    pub status: DiffStatus,
    pub additions: u32,
    pub deletions: u32,
}

/// The changed files in a worktree vs its base branch — committed AND uncommitted,
/// plus untracked — so the reviewer/UI sees the real state (an empty `base..HEAD`
/// does not mean "no changes"; uncommitted edits exist). Tolerant: failed reads
/// degrade to fewer entries rather than erroring.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "WorktreeDiff.ts"))]
pub struct WorktreeDiff {
    pub files: Vec<WorktreeDiffFile>,
    pub summary: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Compute the worktree's changed files vs `base` (committed + uncommitted tracked
/// changes via `git diff <base>`, plus untracked files).
pub fn worktree_diff(dir: &Path, base: &str) -> WorktreeDiff {
    use std::collections::HashMap;
    refresh_index(dir);
    // `--no-renames` keeps numstat ⇄ name-status keyed on a single path per row (a
    // rename becomes a Delete+Add pair) so per-file stats join correctly.
    let mut stats: HashMap<String, (u32, u32)> = HashMap::new();
    if let Ok(numstat) = git(dir, &["diff", "--numstat", "--no-renames", "--end-of-options", base]) {
        for line in numstat.lines() {
            let mut f = line.splitn(3, '\t');
            let add = f.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
            let del = f.next().unwrap_or("0").parse::<u32>().unwrap_or(0);
            if let Some(path) = f.next() {
                if !path.is_empty() {
                    stats.insert(path.to_string(), (add, del));
                }
            }
        }
    }
    let mut files = Vec::new();
    let mut add_total = 0;
    let mut del_total = 0;
    if let Ok(name_status) = git(dir, &["diff", "--name-status", "--no-renames", "--end-of-options", base]) {
        for line in name_status.lines() {
            let mut f = line.splitn(2, '\t');
            let code = f.next().unwrap_or("");
            let Some(path) = f.next().map(str::to_string).filter(|p| !p.is_empty()) else {
                continue;
            };
            let status = match code.chars().next() {
                Some('A') => DiffStatus::Added,
                Some('D') => DiffStatus::Deleted,
                Some('R') => DiffStatus::Renamed,
                _ => DiffStatus::Modified,
            };
            let (a, d) = stats.get(&path).copied().unwrap_or((0, 0));
            add_total += a;
            del_total += d;
            files.push(WorktreeDiffFile {
                path,
                status,
                additions: a,
                deletions: d,
            });
        }
    }
    if let Ok(untracked) = git(dir, &["ls-files", "--others", "--exclude-standard"]) {
        for path in untracked.lines() {
            let path = path.trim();
            if !path.is_empty() {
                files.push(WorktreeDiffFile {
                    path: path.to_string(),
                    status: DiffStatus::Untracked,
                    additions: 0,
                    deletions: 0,
                });
            }
        }
    }
    let summary = format!(
        "{} file{} changed, +{add_total} -{del_total}",
        files.len(),
        if files.len() == 1 { "" } else { "s" }
    );
    WorktreeDiff {
        files,
        summary,
        additions: add_total,
        deletions: del_total,
    }
}
