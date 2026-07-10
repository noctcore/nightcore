//! Read-only single-level directory browsing for the terminal folder picker.
//!
//! The integrated terminal's new-tab picker lets a user open a shell in ANY
//! directory (ported from AutoMaker's file-browser dialog). That needs a way to
//! walk the filesystem one level at a time from the webview — this module is that
//! seam. It is deliberately minimal and READ-ONLY:
//!
//!  - directories only (files are never listed — the picker chooses a *folder*),
//!  - a single level (no recursion),
//!  - hidden (dot-prefixed) dirs excluded unless `include_hidden`,
//!  - each entry flagged `is_git_repo` when it holds a `.git` child (dir or file),
//!  - sorted case-insensitively by name.
//!
//! Everything here is pure filesystem I/O with no Tauri/app coupling, so it
//! unit-tests on any host; the command layer (`commands/fs.rs`) resolves the home
//! default and moves the calls off the UI thread. Permission-denied and
//! not-a-directory are returned as clean error strings, never panics.

use std::path::Path;

use serde::Serialize;
#[cfg(test)]
use ts_rs::TS;

/// One directory entry the picker can descend into. `path` is absolute (the parent
/// is canonicalized, so it is symlink-free up to this segment); the web re-validates
/// / re-canonicalizes it on the next `list_directory` or on spawn, and displays it
/// via `displayPath` (Windows verbatim-prefix stripping).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "DirectoryEntry.ts"))]
pub struct DirectoryEntry {
    /// The directory's own name (its last path segment).
    pub name: String,
    /// The absolute path to the directory.
    pub path: String,
    /// `true` when the directory contains a `.git` child (a dir for a normal
    /// checkout, a file for a linked worktree) — the picker marks these so the user
    /// can spot repos while browsing.
    pub is_git_repo: bool,
}

/// A single directory's listing: where we are, where "up" goes, and the child
/// directories. Returned by `list_directory`; the picker renders the breadcrumb
/// from `current_path`, the up-affordance from `parent_path`, and the list from
/// `entries`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "DirectoryListing.ts"))]
pub struct DirectoryListing {
    /// The canonical absolute path that was listed.
    pub current_path: String,
    /// The parent directory's absolute path, or `None` at a filesystem root.
    pub parent_path: Option<String>,
    /// The child directories (dirs only, hidden filtered unless requested), sorted
    /// case-insensitively by name.
    pub entries: Vec<DirectoryEntry>,
}

/// List the child DIRECTORIES of `path`, one level deep. Canonicalizes `path` first
/// (so a `..`/symlink input resolves to a real, stable location), requires it to be
/// a directory, then reads its entries keeping only sub-directories. Hidden
/// (dot-prefixed) dirs are excluded unless `include_hidden`. Entries are sorted
/// case-insensitively by name.
///
/// Errors (never panics):
///  - `path` does not exist / cannot be resolved → "… does not exist",
///  - `path` is a file, not a directory → "… is not a directory",
///  - the directory can't be read (e.g. permission denied) → "cannot read …: <os>".
pub fn list_directory(path: &Path, include_hidden: bool) -> Result<DirectoryListing, String> {
    let canon =
        std::fs::canonicalize(path).map_err(|_| format!("{} does not exist", path.display()))?;
    if !canon.is_dir() {
        return Err(format!("{} is not a directory", canon.display()));
    }

    let read =
        std::fs::read_dir(&canon).map_err(|e| format!("cannot read {}: {e}", canon.display()))?;

    let mut entries: Vec<DirectoryEntry> = Vec::new();
    for entry in read.flatten() {
        let child = entry.path();
        // Directories only — a picker chooses a folder, never a file. `file_type()`
        // (a cheap stat) avoids following into unreadable children; fall back to
        // `is_dir` when the type is unavailable.
        let is_dir = match entry.file_type() {
            Ok(ft) => ft.is_dir(),
            Err(_) => child.is_dir(),
        };
        if !is_dir {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !include_hidden && name.starts_with('.') {
            continue;
        }
        let is_git_repo = child.join(".git").exists();
        entries.push(DirectoryEntry {
            name,
            path: child.to_string_lossy().into_owned(),
            is_git_repo,
        });
    }

    // Case-insensitive by name so the list reads naturally regardless of case.
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(DirectoryListing {
        current_path: canon.to_string_lossy().into_owned(),
        parent_path: canon.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

/// Whether `path` still resolves to an existing directory — the fail-closed probe
/// behind the terminal's "start a fresh shell here" restore action (a persisted
/// session's cwd may have been deleted since it was recorded). Canonicalizes so a
/// symlinked cwd is judged by its real target; any resolution failure is a clean
/// `false` (fail closed: the restore action stays disabled).
pub fn is_directory(path: &Path) -> bool {
    std::fs::canonicalize(path)
        .map(|p| p.is_dir())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn lists_only_directories_sorted_case_insensitively() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("Zeta")).unwrap();
        fs::create_dir(root.join("alpha")).unwrap();
        fs::create_dir(root.join("Beta")).unwrap();
        fs::write(root.join("a-file.txt"), "x").unwrap(); // a FILE must not appear

        let listing = list_directory(root, false).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["alpha", "Beta", "Zeta"],
            "dirs only, case-insensitive sort"
        );
    }

    #[test]
    fn hidden_dirs_excluded_by_default_included_on_request() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir(root.join("visible")).unwrap();
        fs::create_dir(root.join(".hidden")).unwrap();

        let default = list_directory(root, false).unwrap();
        let default_names: Vec<&str> = default.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            default_names,
            vec!["visible"],
            "dot-dirs excluded by default"
        );

        let with_hidden = list_directory(root, true).unwrap();
        let hidden_names: Vec<&str> = with_hidden
            .entries
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(
            hidden_names,
            vec![".hidden", "visible"],
            "include_hidden surfaces dot-dirs"
        );
    }

    #[test]
    fn marks_git_repos_via_a_dot_git_child() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // A normal checkout: `.git` is a directory.
        let repo = root.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        // A linked worktree: `.git` is a FILE (gitdir pointer).
        let worktree = root.join("worktree");
        fs::create_dir(&worktree).unwrap();
        fs::write(worktree.join(".git"), "gitdir: /somewhere\n").unwrap();
        // A plain directory: no `.git`.
        fs::create_dir(root.join("plain")).unwrap();

        let listing = list_directory(root, false).unwrap();
        let by_name = |n: &str| listing.entries.iter().find(|e| e.name == n).unwrap();
        assert!(by_name("repo").is_git_repo, "a .git dir marks a repo");
        assert!(
            by_name("worktree").is_git_repo,
            "a .git file (linked worktree) marks a repo"
        );
        assert!(!by_name("plain").is_git_repo, "no .git → not a repo");
    }

    #[test]
    fn reports_parent_and_canonical_current_path() {
        let tmp = TempDir::new().unwrap();
        let child = tmp.path().join("child");
        fs::create_dir(&child).unwrap();

        let listing = list_directory(&child, false).unwrap();
        // Both sides canonicalized so the comparison holds on macOS (/var → /private/var).
        let canon_child = fs::canonicalize(&child).unwrap();
        let canon_parent = fs::canonicalize(tmp.path()).unwrap();
        assert_eq!(listing.current_path, canon_child.to_string_lossy());
        assert_eq!(
            listing.parent_path.as_deref(),
            Some(canon_parent.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn missing_path_is_a_clean_error_not_a_panic() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("no-such-dir");
        let err = list_directory(&missing, false).unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
    }

    #[test]
    fn a_file_target_is_rejected_as_not_a_directory() {
        let tmp = TempDir::new().unwrap();
        let file = tmp.path().join("file.txt");
        fs::write(&file, "x").unwrap();
        let err = list_directory(&file, false).unwrap_err();
        assert!(err.contains("is not a directory"), "got: {err}");
    }

    #[test]
    fn is_directory_probe_is_fail_closed() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("d");
        fs::create_dir(&dir).unwrap();
        let file = tmp.path().join("f");
        fs::write(&file, "x").unwrap();

        assert!(is_directory(&dir), "an existing dir probes true");
        assert!(!is_directory(&file), "a file probes false");
        assert!(
            !is_directory(&tmp.path().join("gone")),
            "a missing path probes false (fail closed)"
        );
    }
}
