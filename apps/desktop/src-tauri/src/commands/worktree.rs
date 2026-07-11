//! Read-only worktree queries (branch list, merge preview, diff) + the discard
//! action — the command surface for the branch picker and the worktree manager.
//!
//! These legitimately depend on both persistence ([`crate::store`]) and, for the
//! discard guard, orchestration ([`crate::orchestration`]), so they live in the
//! command layer (see `commands/mod.rs`). Git itself runs entirely in
//! [`crate::worktree`]; this module only resolves project/task → calls those
//! primitives off the UI thread.

use tauri::{AppHandle, Emitter, Manager};

use crate::project::ProjectStore;
use crate::store::TaskStore;
use crate::task::{Task, TASK_EVENT};
use crate::worktree::{self, BranchInfo, MergePreview, UpdateFromBaseStatus, WorktreeDiff};

/// The active project's path, or an error for a command that needs one.
fn active_project_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.state::<ProjectStore>()
        .active()
        .map(|p| std::path::PathBuf::from(&p.path))
        .ok_or_else(|| "no active project".to_string())
}

/// Resolve a task's worktree branch: its recorded branch, else the default `nc/<id>`.
fn task_branch(task: &Task) -> String {
    task.branch
        .clone()
        .unwrap_or_else(|| worktree::branch_name(&task.id))
}

/// The active project's branches (local + remote-tracking) for the branch picker.
/// Empty when there is no active project (the picker degrades to free-form entry).
/// The git read runs off the UI thread, matching the sibling queries.
#[tauri::command]
pub async fn list_branches(app: AppHandle) -> Result<Vec<BranchInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(project) = app.state::<ProjectStore>().active() else {
            return Ok(Vec::new());
        };
        Ok(worktree::list_branches(&std::path::PathBuf::from(
            &project.path,
        )))
    })
    .await
    .map_err(|e| format!("list branches failed to run: {e}"))?
}

/// Preview merging a task's worktree branch into `base` (defaults to the project's
/// base branch) — read-only. The git reads run off the UI thread.
#[tauri::command]
pub async fn merge_preview(
    app: AppHandle,
    id: String,
    base: Option<String>,
) -> Result<MergePreview, String> {
    tauri::async_runtime::spawn_blocking(move || merge_preview_blocking(&app, &id, base))
        .await
        .map_err(|e| format!("merge preview failed to run: {e}"))?
}

fn merge_preview_blocking(
    app: &AppHandle,
    id: &str,
    base: Option<String>,
) -> Result<MergePreview, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = active_project_path(app)?;
    let branch = task_branch(&task);
    // Preview against the task's chosen base (matching what `merge_task` will target),
    // an explicit override, else the project's current branch — validated identically to
    // `merge_branch` so a bogus/option-shaped base fails loudly here instead of yielding a
    // silently degraded preview that the actual (validating) merge would then reject.
    let base = resolve_preview_base(base, task.base_branch.as_deref(), &project)?;
    // The resolved branch is validated too, mirroring `merge_branch`'s two-ref check.
    crate::git::validate_ref(&branch)?;
    Ok(worktree::merge_preview(&project, &branch, &base))
}

/// Resolve the preview base (explicit override → task's stored base → project's current
/// branch) and reject an illegal/option-shaped ref before it reaches git — mirroring
/// [`merge_branch`], so a read-only preview and the merge it previews agree on what is a
/// legal base.
fn resolve_preview_base(
    explicit: Option<String>,
    task_base: Option<&str>,
    project: &std::path::Path,
) -> Result<String, String> {
    let base = explicit
        .or_else(|| task_base.map(str::to_string))
        .unwrap_or_else(|| worktree::base_branch(project));
    crate::git::validate_ref(&base)?;
    Ok(base)
}

/// The changed files in a task's worktree vs base (committed + uncommitted + untracked).
#[tauri::command]
pub async fn worktree_diff(app: AppHandle, id: String) -> Result<WorktreeDiff, String> {
    tauri::async_runtime::spawn_blocking(move || worktree_diff_blocking(&app, &id))
        .await
        .map_err(|e| format!("worktree diff failed to run: {e}"))?
}

fn worktree_diff_blocking(app: &AppHandle, id: &str) -> Result<WorktreeDiff, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = active_project_path(app)?;
    let dir = worktree::worktree_path(&project, id);
    if !dir.exists() {
        return Err(format!("no worktree for task {id} — run it first"));
    }
    // Diff against the task's chosen base (matching the merge target), else the
    // project's current branch.
    let base = task
        .base_branch
        .clone()
        .unwrap_or_else(|| worktree::base_branch(&project));
    Ok(worktree::worktree_diff(&dir, &base))
}

/// The unified-diff patch text for ONE changed file in a task's worktree vs base
/// (T13's per-file patch viewer). `path` is one of the entries `worktree_diff`
/// returned; the worktree resolves the same base the file list was computed against, and
/// the path is confined to the worktree server-side ([`worktree::file_diff`]). The git
/// read runs off the UI thread.
#[tauri::command]
pub async fn worktree_file_diff(
    app: AppHandle,
    id: String,
    path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || worktree_file_diff_blocking(&app, &id, &path))
        .await
        .map_err(|e| format!("worktree file diff failed to run: {e}"))?
}

fn worktree_file_diff_blocking(app: &AppHandle, id: &str, path: &str) -> Result<String, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = active_project_path(app)?;
    let dir = worktree::worktree_path(&project, id);
    if !dir.exists() {
        return Err(format!("no worktree for task {id} — run it first"));
    }
    let base = task
        .base_branch
        .clone()
        .unwrap_or_else(|| worktree::base_branch(&project));
    worktree::file_diff(&dir, &base, path)
}

/// Pull the base branch INTO a task's worktree branch — the "Update from base" action
/// (T13). Merges `base` into `nc/<taskId>` inside the worktree so a branch cut before a
/// base-only commit (the documented silent-revert incident class) stops reverting it on
/// merge. Refuses while the task is actively running (the slot lease, mirroring
/// [`discard_worktree`]) and while the worktree is dirty (server-side). A clean update
/// emits `nc:task` so the board refreshes the branch's ahead/behind. The git work runs
/// off the UI thread.
#[tauri::command]
pub async fn update_worktree_from_base(
    app: AppHandle,
    id: String,
) -> Result<UpdateFromBaseStatus, String> {
    tauri::async_runtime::spawn_blocking(move || update_worktree_from_base_blocking(&app, &id))
        .await
        .map_err(|e| format!("update from base failed to run: {e}"))?
}

fn update_worktree_from_base_blocking(
    app: &AppHandle,
    id: &str,
) -> Result<UpdateFromBaseStatus, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    // Refuse to rewrite a worktree out from under a live run (authoritative: the slot
    // lease), mirroring `discard_worktree`.
    if let Some(orch) = app.try_state::<crate::orchestration::coordinator::Orchestrator>() {
        if orch.slots.is_leased(id) {
            return Err(
                "this task is still running — stop it before updating its worktree".to_string(),
            );
        }
    }
    let project = active_project_path(app)?;
    let dir = worktree::worktree_path(&project, id);
    if !dir.exists() {
        return Err(format!("no worktree for task {id} — run it first"));
    }
    let base = task
        .base_branch
        .clone()
        .unwrap_or_else(|| worktree::base_branch(&project));
    let outcome = worktree::update_from_base(&dir, &base)?;
    // A clean update advanced the worktree branch — clear any stale conflict flag and
    // emit `nc:task` so the switcher/board refresh the branch's ahead/behind counts.
    if outcome == UpdateFromBaseStatus::Updated {
        if let Ok(updated) = store.mutate(id, |t| t.conflict = false) {
            let _ = app.emit(TASK_EVENT, &updated);
        }
    }
    Ok(outcome)
}

/// Discard a task's worktree and its branch — a safe cleanup distinct from deleting
/// the task. Removes the worktree dir (robustly), then deletes its branch (guarded
/// so the base branch can never be deleted), clears any conflict/error flag, and
/// clears the task's `branch` pointer so its board/worktree tab drops (the task
/// itself stays, falling back to the Main tab). Refuses while the task is actively
/// running. Idempotent + tolerant: when the worktree dir is ALREADY gone from disk
/// (a manual `rm`), `remove` prunes git's stale admin refs so the branch still
/// deletes cleanly rather than erroring. Best-effort; emits `nc:task`.
#[tauri::command]
pub async fn discard_worktree(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || discard_worktree_blocking(&app, &id))
        .await
        .map_err(|e| format!("discard worktree failed to run: {e}"))?
}

fn discard_worktree_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    // Refuse to pull a worktree out from under a live run (authoritative: the slot
    // lease). A finished/failed/idle task is safe to discard.
    if let Some(orch) = app.try_state::<crate::orchestration::coordinator::Orchestrator>() {
        if orch.slots.is_leased(id) {
            return Err(
                "this task is still running — stop it before discarding its worktree".to_string(),
            );
        }
    }
    let project = active_project_path(app)?;
    // Remove the worktree first (frees its checked-out branch), then delete the
    // branch — the load-bearing order (deleting a checked-out branch fails).
    worktree::remove(&project, id)?;
    let _ = worktree::delete_branch_named(&project, &task_branch(&task));
    let updated = store.mutate(id, |t| {
        // Clear the branch pointer so the switcher's synthesized tab drops (the
        // task returns to the Main tab); the task record itself is preserved.
        t.branch = None;
        t.conflict = false;
        t.error = None;
    })?;
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(())
}

// ─── Terminal-created worktrees (spec PR 5) ─────────────────────────────────────
// A SEPARATE surface from the task worktrees above: the terminal new-tab picker's
// "Create new worktree…" path creates one, the Worktrees manager lists + discards them,
// and the cleanup interlock (web-side, keyed on `terminalSessionsInDir(path)`) covers
// them for free. They live under `.nightcore/worktrees-term/<slug>` with a `term/<slug>`
// branch — outside the `nc/<taskId>` namespace the board monitor + startup reconcile key
// on — so relaunch never garbage-collects them (spec §10 flag 3). USER-only, like every
// terminal seam.

/// Create a user-driven terminal worktree from the new-tab picker (spec PR 5a). Slugs the
/// display `name` SERVER-SIDE (the webview value is never trusted), then allocates a
/// worktree under the terminal base — a new `term/<slug>` branch off `base` when
/// `create_branch`, else a detached checkout at `base`. Returns the new worktree's status
/// (the `WorktreeInfo` the picker spawns a terminal into + the manager lists). Async +
/// `spawn_blocking` (git off the UI thread).
#[tauri::command]
pub async fn terminal_create_worktree(
    app: AppHandle,
    name: String,
    create_branch: bool,
    base: Option<String>,
) -> Result<worktree::WorktreeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = active_project_path(&app)?;
        let slug = worktree::slugify(&name)
            .ok_or_else(|| "enter a name with at least one letter or number".to_string())?;
        // Default the base to the project's base branch when the picker left it blank.
        let base_ref = base
            .filter(|b| !b.trim().is_empty())
            .unwrap_or_else(|| worktree::base_branch(&project));
        let dir = worktree::allocate_terminal(&project, &slug, create_branch, &base_ref)?;
        // Report status diffed against the project's base branch (matching the manager
        // list), regardless of the chosen create base.
        Ok(worktree::terminal_worktree_status(
            &dir,
            &slug,
            &worktree::base_branch(&project),
        ))
    })
    .await
    .map_err(|e| format!("terminal create worktree failed to run: {e}"))?
}

/// The active project's user-created terminal worktrees (spec PR 5) — the "Terminal
/// worktrees" group in the Worktrees manager. Read-only git status; tolerant. Empty when
/// there is no active project. Async + `spawn_blocking`.
#[tauri::command]
pub async fn list_terminal_worktrees(
    app: AppHandle,
) -> Result<Vec<worktree::WorktreeStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(project) = app.state::<ProjectStore>().active() else {
            return Ok(Vec::new());
        };
        Ok(worktree::list_terminal_worktree_statuses(
            &std::path::PathBuf::from(&project.path),
        ))
    })
    .await
    .map_err(|e| format!("list terminal worktrees failed to run: {e}"))?
}

/// Discard a user-created terminal worktree by `slug` and delete its `term/<slug>` branch
/// (spec PR 5c) — the terminal counterpart of [`discard_worktree`]. The slug is
/// re-validated + the removal is `is_under`-guarded to the terminal base SERVER-SIDE, so a
/// webview-supplied value can never escape it. The web closes any live terminal in the
/// worktree first (the cleanup interlock), mirroring the task discard order. Async +
/// `spawn_blocking`; rejects on a real failure so the caller can surface it.
#[tauri::command]
pub async fn discard_terminal_worktree(app: AppHandle, slug: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = active_project_path(&app)?;
        // Remove the worktree first (frees its checked-out branch), then delete the
        // branch — the load-bearing order (deleting a checked-out branch fails). Branch
        // delete is best-effort: a `--detach` (no-branch) worktree has no `term/<slug>`.
        worktree::remove_terminal(&project, &slug)?;
        let _ = worktree::delete_branch_named(&project, &worktree::terminal_branch_name(&slug));
        Ok(())
    })
    .await
    .map_err(|e| format!("discard terminal worktree failed to run: {e}"))?
}

/// Resolve a task's worktree dir from the store and confirm it exists AND lives
/// under the project's `.nightcore/worktrees/` base — the shared guard for the
/// reveal / open-in-editor conveniences. The path is computed server-side from the
/// task id (the webview never supplies a raw path), so a stored field or model
/// output can never point these OS openers at an arbitrary location; the
/// `is_under` assertion is defense-in-depth against a future refactor widening it.
fn resolve_worktree_dir(app: &AppHandle, id: &str) -> Result<std::path::PathBuf, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    // A stale/unknown id must open nothing.
    store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = active_project_path(app)?;
    let dir = worktree::worktree_path(&project, id);
    if !worktree::is_under(&worktree::worktrees_base(&project), &dir) {
        return Err("refusing to open a path outside the worktrees directory".to_string());
    }
    if !dir.exists() {
        return Err(format!(
            "no worktree for task {id} — run it first, or it was discarded"
        ));
    }
    Ok(dir)
}

/// Reveal a task's worktree directory in the OS file manager (Finder `open -R`,
/// Linux `xdg-open`, Windows `explorer /select`). The path is resolved SERVER-SIDE
/// from the store and confined to the worktrees base (see [`resolve_worktree_dir`]),
/// mirroring `open_external`'s posture — the webview never supplies a path. A pure
/// user-gesture convenience; the opener is reaped on a detached thread. Async +
/// `spawn_blocking` (store read + git-path checks off the UI thread). Errors when
/// the worktree is gone so the web can toast.
#[tauri::command]
pub async fn reveal_worktree(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = resolve_worktree_dir(&app, &id)?;
        crate::infra::editor::reveal_in_file_manager(&dir)
    })
    .await
    .map_err(|e| format!("reveal worktree failed to run: {e}"))?
}

/// Open a task's worktree directory in the user's editor. The editor is resolved
/// from Settings (`preferred_editor`, an allowlisted known-editor id) with a
/// CLI-first auto-detect fallback (see [`crate::infra::editor::resolve_editor`]);
/// the path is resolved SERVER-SIDE + confined exactly like [`reveal_worktree`].
/// Async + `spawn_blocking`; the editor is spawned with the path as a single argv
/// (never a shell string) and reaped on a thread.
#[tauri::command]
pub async fn open_in_editor(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = resolve_worktree_dir(&app, &id)?;
        // The preferred editor is a global user preference; a missing settings store
        // (unusual) just means auto-detect.
        let preferred = match app.try_state::<crate::settings::SettingsStore>() {
            Some(store) => store.with_settings(|s| s.preferred_editor.clone()),
            None => None,
        };
        let editor = crate::infra::editor::resolve_editor(preferred.as_deref())?;
        crate::infra::editor::open_in_editor_at(&editor, &dir)
    })
    .await
    .map_err(|e| format!("open in editor failed to run: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn preview_base_rejects_option_shaped_explicit_base() {
        // An explicit option-shaped base must be rejected before it reaches git —
        // identical to `merge_branch`'s `validate_ref`, so the preview and the merge it
        // previews never disagree on what is a legal base. (The explicit override wins,
        // so the project path is never consulted.)
        for bad in ["--all", "-D", "--orphan", "-"] {
            let err = resolve_preview_base(Some(bad.to_string()), None, Path::new("/nonexistent"))
                .unwrap_err();
            assert!(
                err.contains("invalid branch/base name"),
                "explicit base {bad:?} must be rejected loudly, got: {err}"
            );
        }
    }

    #[test]
    fn preview_base_accepts_a_legal_explicit_base() {
        let base = resolve_preview_base(Some("main".to_string()), None, Path::new("/nonexistent"))
            .expect("a legal explicit base must resolve");
        assert_eq!(base, "main");
    }

    #[test]
    fn preview_base_validates_a_bogus_task_base() {
        // Falling back to the task's stored base must also be validated (an option-shaped
        // stored base must not slip through into a degraded preview).
        let err =
            resolve_preview_base(None, Some("--force"), Path::new("/nonexistent")).unwrap_err();
        assert!(
            err.contains("invalid branch/base name"),
            "a bogus task base must be rejected, got: {err}"
        );
    }
}
