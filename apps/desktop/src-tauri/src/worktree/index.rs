//! Git stat-cache refresh — a tiny worktree helper.
//!
//! Lifted out of `worktree/mod.rs` into a sibling so the module stays a manifest
//! (issue #17 phase D). Submodules reach it as `super::refresh_index` via the
//! private re-binding in `mod.rs`.

use std::path::Path;

use crate::git::run::git_status_success;

/// Best-effort `git update-index --refresh` in `dir` to clear git's stale stat
/// cache. Without it, a worktree that was only `stat`-touched (a build that wrote
/// then restored a file's mtime) can report a false-positive "uncommitted changes"
/// in `git status`. Errors are deliberately swallowed — it is a pure optimization
/// and must never fail a higher-level read (Aperant `refreshGitIndex`).
pub(super) fn refresh_index(dir: &Path) {
    let _ = git_status_success(dir, &["update-index", "--refresh"]);
}
