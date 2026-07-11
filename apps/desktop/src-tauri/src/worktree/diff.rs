//! Diff parsing: per-file `--numstat` stats and the worktree-vs-base file list.
//!
//! [`diff_numstat`] is shared with the merge preview ([`super::merge`]); the
//! working-tree-inclusive [`worktree_diff`] (committed + uncommitted + untracked)
//! feeds the reviewer/UI.

use std::path::{Component, Path, PathBuf};

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
        &[
            "diff",
            "--numstat",
            "--no-renames",
            "--end-of-options",
            range,
        ],
    )
    .unwrap_or_default();
    let mut files = Vec::new();
    let mut add_total = 0;
    let mut del_total = 0;
    for row in crate::git::parse::parse_numstat(&out) {
        let (add, del) = (row.additions as u32, row.deletions as u32);
        add_total += add;
        del_total += del;
        files.push(DiffFileStat {
            path: row.path,
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

/// The committed diff of `dir`'s HEAD vs its merge-base with `base`
/// (`git diff <base>...HEAD`) — the authoritative payload for PR drafting (PR
/// arc, phase 1). Validates `base` before it is spliced into the range argument
/// (the combined `<base>...HEAD` positional cannot begin with `-` once `base`
/// passes [`crate::git::validate_ref`]).
pub fn base_diff(dir: &Path, base: &str) -> Result<String, String> {
    crate::git::validate_ref(base)?;
    git(dir, &["diff", &format!("{base}...HEAD")])
}

/// Cap on the synthesized-patch read for an untracked file — a huge generated file
/// can't balloon the per-file review payload.
const MAX_FILE_DIFF_BYTES: usize = 512 * 1024;

/// The unified-diff patch text for ONE file in a worktree vs `base` — the per-file
/// review payload (T13's real patch viewer; the file-list `WorktreeDiff` bottoms out at
/// filenames). Tracked changes (committed + uncommitted) come from
/// `git diff <base> -- <path>` (a plain diff exits 0 even with differences). An
/// untracked NEW file — absent from `git diff <base>`, and cross-platform-awkward via
/// `--no-index` — is rendered as an all-additions synthetic patch; a non-UTF-8 (binary)
/// file is reported, not dumped, and an over-cap file is refused. `path` is confined to
/// the worktree ([`sanitize_diff_path`]) so a crafted/relative entry can never read
/// outside it.
pub fn file_diff(dir: &Path, base: &str, path: &str) -> Result<String, String> {
    crate::git::validate_ref(base)?;
    let rel = sanitize_diff_path(path)?;
    refresh_index(dir);
    // Tracked changes vs base (committed + staged + unstaged); `--` fences the path so a
    // pathspec starting with `-` can't be read as an option.
    let patch = git(dir, &["diff", "--end-of-options", base, "--", &rel]).unwrap_or_default();
    if !patch.trim().is_empty() {
        return Ok(patch);
    }
    // No tracked diff ⇒ an untracked new file (or one just deleted from disk). This is the
    // ONE branch that touches the filesystem directly (the `git diff` above is git-confined),
    // so confine the read to the worktree: `sanitize_diff_path` is only the LEXICAL layer,
    // and an untracked SYMLINK (`notes.txt -> /outside/secret`, which a confined agent CAN
    // create — the link lives inside the worktree — or a malicious repo's postinstall can
    // plant) would otherwise be FOLLOWED by `std::fs::read` and leak an out-of-worktree file
    // through the full-privilege backend. Reject any symlink in the path; a non-confined
    // entry is shown as "not viewable", never read.
    let full = match confined_untracked_path(dir, &rel) {
        Ok(full) => full,
        Err(_) => {
            return Ok(format!(
                "File {rel} is not shown (path is not confined to the worktree)"
            ))
        }
    };
    match std::fs::read(&full) {
        Ok(bytes) if bytes.len() > MAX_FILE_DIFF_BYTES => Err(format!(
            "file too large to preview ({} bytes, max {MAX_FILE_DIFF_BYTES})",
            bytes.len()
        )),
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => Ok(synth_added_patch(&rel, &text)),
            Err(_) => Ok(format!("Binary file {rel} (not shown)")),
        },
        // The file is gone (e.g. staged then removed) — nothing to show, not an error.
        Err(_) => Ok(String::new()),
    }
}

/// Confine a diff path to the worktree LEXICALLY: reject an absolute path or any
/// `..`/`.`/root component so a crafted entry can never climb out. The paths from
/// [`worktree_diff`] are git-authored repo-relative, so this never rejects a real entry.
/// This is layer 1 only — the symlink-escape layer lives in [`confined_untracked_path`],
/// applied before the untracked-file read.
fn sanitize_diff_path(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("empty diff path".to_string());
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return Err("diff path must be relative".to_string());
    }
    for comp in p.components() {
        if !matches!(comp, Component::Normal(_)) {
            return Err("diff path must not traverse".to_string());
        }
    }
    Ok(path.to_string())
}

/// Resolve a lexically-clean `rel` (all `Normal` components — see [`sanitize_diff_path`])
/// against the worktree `dir` for the untracked-file READ, rejecting a symlink escape.
/// `sanitize_diff_path` blocks `..`/absolute but NOT a symlink: an untracked
/// `notes.txt -> /outside/secret` passes the lexical check, yet `std::fs::read` would
/// follow it out of the worktree. Walk the joined path component-by-component with
/// `symlink_metadata` (lstat — does NOT follow links, unlike `exists()`, so a DANGLING
/// leaf symlink is caught too) and reject if ANY component is a symlink; then assert the
/// result still sits under the canonical worktree root. This is the symlink-escape layer
/// of the repo's `safe_join`, replicated because that helper is `pub(super)` to the
/// harness module AND carries write-oriented execution-sink denylists that must not
/// reject a read-only diff view of a legitimate file (e.g. `agents.md`, `.github/…`).
///
/// TODO(#178): call the hoisted shared `safe_join` here once it moves to `infra/`
/// (dropping the write-only denylists for this read path).
fn confined_untracked_path(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = dir
        .canonicalize()
        .map_err(|e| format!("worktree {} is not accessible: {e}", dir.display()))?;
    let mut current = root.clone();
    for comp in Path::new(rel).components() {
        // `sanitize_diff_path` guarantees only Normal components reach here.
        let Component::Normal(name) = comp else {
            return Err("diff path must not traverse".to_string());
        };
        current.push(name);
        if let Ok(meta) = std::fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "diff path passes through a symlink (rejected): {rel}"
                ));
            }
        }
    }
    // Defence in depth: with no symlink in the chain and no `..`, `current` is inside the
    // root by construction — assert it anyway (matches `safe_join`).
    if current != root && !current.starts_with(&root) {
        return Err(format!("diff path resolves outside the worktree: {rel}"));
    }
    Ok(current)
}

/// Build an all-additions unified-diff patch for an untracked new file — every line a
/// `+`, headed by a `/dev/null → b/<path>` hunk — so the per-file viewer can render a new
/// file with the same renderer it uses for tracked patches.
fn synth_added_patch(path: &str, text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = String::new();
    out.push_str(&format!("diff --git a/{path} b/{path}\n"));
    out.push_str("new file\n");
    out.push_str("--- /dev/null\n");
    out.push_str(&format!("+++ b/{path}\n"));
    out.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
    for line in &lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Compute the worktree's changed files vs `base` (committed + uncommitted tracked
/// changes via `git diff <base>`, plus untracked files).
pub fn worktree_diff(dir: &Path, base: &str) -> WorktreeDiff {
    use std::collections::HashMap;
    refresh_index(dir);
    // `--no-renames` keeps numstat ⇄ name-status keyed on a single path per row (a
    // rename becomes a Delete+Add pair) so per-file stats join correctly.
    let mut stats: HashMap<String, (u32, u32)> = HashMap::new();
    if let Ok(numstat) = git(
        dir,
        &[
            "diff",
            "--numstat",
            "--no-renames",
            "--end-of-options",
            base,
        ],
    ) {
        for row in crate::git::parse::parse_numstat(&numstat) {
            stats.insert(row.path, (row.additions as u32, row.deletions as u32));
        }
    }
    let mut files = Vec::new();
    let mut add_total = 0;
    let mut del_total = 0;
    if let Ok(name_status) = git(
        dir,
        &[
            "diff",
            "--name-status",
            "--no-renames",
            "--end-of-options",
            base,
        ],
    ) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_diff_path_accepts_a_repo_relative_path() {
        assert_eq!(
            sanitize_diff_path("src/app/main.rs").unwrap(),
            "src/app/main.rs"
        );
        assert_eq!(sanitize_diff_path("README.md").unwrap(), "README.md");
    }

    #[test]
    fn sanitize_diff_path_rejects_traversal_and_absolute() {
        for bad in ["", "../secret", "a/../../etc/passwd", "/etc/passwd", "./x"] {
            assert!(
                sanitize_diff_path(bad).is_err(),
                "path {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn synth_added_patch_marks_every_line_added() {
        let patch = synth_added_patch("new.txt", "alpha\nbeta\n");
        assert!(patch.contains("--- /dev/null"));
        assert!(patch.contains("+++ b/new.txt"));
        assert!(patch.contains("@@ -0,0 +1,2 @@"));
        assert!(patch.contains("+alpha"));
        assert!(patch.contains("+beta"));
        // No context/deletion lines in a synthesized new-file patch.
        assert!(!patch
            .lines()
            .any(|l| l.starts_with('-') && !l.starts_with("---")));
    }
}
