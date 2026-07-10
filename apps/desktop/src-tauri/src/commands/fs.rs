//! Read-only filesystem browsing commands for the terminal folder picker.
//!
//! Thin async wrappers over [`crate::infra::browse`] (the pure listing logic).
//! They exist so the integrated terminal's new-tab picker can let a user open a
//! shell in ANY directory (ported from AutoMaker's file-browser dialog): the
//! picker walks the filesystem one level at a time, then hands the chosen path to
//! `terminal_spawn`.
//!
//! ALL async + `spawn_blocking` — `read_dir`/`canonicalize` are blocking syscalls
//! and a sync `#[tauri::command]` runs on the WKWebView main thread (the known
//! freeze trap). These are READ-ONLY: they list directory names and probe
//! existence; they never read file contents, recurse, or write anything.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::infra::browse::{self, DirectoryListing};

/// List the child directories of `path`, one level deep. When `path` is `None` the
/// listing starts from the user's home directory (the picker's default landing) —
/// this folds the "home default" into the listing so no separate home command is
/// needed. `include_hidden` surfaces dot-prefixed directories (off by default).
/// Directories only; sorted case-insensitively; each entry flagged `is_git_repo`.
#[tauri::command]
pub async fn list_directory(
    app: AppHandle,
    path: Option<String>,
    include_hidden: bool,
) -> Result<DirectoryListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target: PathBuf = match path {
            Some(p) => PathBuf::from(p),
            // No path → home directory (the picker opens here by default).
            None => app
                .path()
                .home_dir()
                .map_err(|_| "cannot resolve the home directory".to_string())?,
        };
        browse::list_directory(&target, include_hidden)
    })
    .await
    .map_err(|e| format!("list_directory failed to run: {e}"))?
}

/// Whether `path` still resolves to an existing directory — the fail-closed probe
/// behind the terminal restore action ("start a fresh shell here"). Returns `false`
/// (never an error) for a missing / non-directory / unresolvable path, so the web
/// treats it as "not restorable" and disables the action with a hint.
#[tauri::command]
pub async fn directory_exists(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || browse::is_directory(&PathBuf::from(path)))
        .await
        .map_err(|e| format!("directory_exists failed to run: {e}"))
}
