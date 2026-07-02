//! The task CRUD command handlers.
//!
//! The `#[tauri::command]` handlers over the task registry, registered in `lib.rs`
//! as `commands::task::*` and invoked from the webview. They sit ABOVE the
//! persistence layer: each mutation goes through the
//! [`TaskStore`](crate::store::TaskStore) (persist) and emits `nc:task` (the full
//! task) so the webview can upsert its board by id. The worktree-cleanup and
//! dependency-blocking handlers legitimately up-call [`crate::orchestration`],
//! which is why they live in this command layer rather than in the `store/task`
//! persistence leaf.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::store::TaskStore;
use crate::task::{
    build_new_task, convert_one, move_task_inner, CreateInputs, RunMode, SubtaskStatus, Task,
    TaskKind, TaskPatch, TASK_EVENT,
};

// --- Commands ---------------------------------------------------------------

/// All tasks currently in the registry (unordered; the webview groups by status).
///
/// Returns `Arc<Task>`: the store shares its board pointers, and `Arc<Task>`
/// serializes over the IPC wire identically to `Task`, so the webview payload is
/// unchanged while the snapshot avoids a deep clone per task.
#[tauri::command]
pub fn list_tasks(store: State<'_, TaskStore>) -> Result<Vec<Arc<Task>>, String> {
    Ok(store.list())
}

/// Create a new backlog task, persist it, and emit `nc:task`. The run mode is the
/// explicit `run_mode` argument when given, else the project's default (per-project
/// override → global `default_run_mode` → `main`), so a new task inherits the
/// configured default unless the create call overrides it (M4.6 §B).
// A Tauri command: the args are the IPC payload fields (three injected `State`s
// plus the create inputs), not a refactorable call seam — the flat list is the
// command surface.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn create_task(
    app: AppHandle,
    store: State<'_, TaskStore>,
    settings: State<'_, crate::settings::SettingsStore>,
    projects: State<'_, crate::project::ProjectStore>,
    title: String,
    description: String,
    kind: Option<TaskKind>,
    run_mode: Option<RunMode>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    branch: Option<String>,
    base_branch: Option<String>,
    attachments: Vec<crate::store::attachments::NewAttachment>,
) -> Result<Task, String> {
    // Resolve every default once against the active project (per-project override →
    // global), mirroring how `default_run_mode` is applied — so the Settings
    // defaults are authoritative for a new task without the web having to seed them.
    let project_id = projects.active().map(|p| p.id);
    let mut task = build_new_task(
        &settings,
        project_id.as_deref(),
        title,
        description,
        CreateInputs {
            kind,
            run_mode,
            model,
            effort,
            permission_mode,
            max_turns,
            max_budget_usd,
            branch,
            base_branch,
        },
    );
    // Persist any attached images to app-data under the freshly-minted task id BEFORE
    // the task is stored. A validation failure (bad format/oversize/too many) aborts
    // the create with nothing persisted; clean up any files written before a later
    // disk-write error so a failed create leaves no orphan dir.
    if !attachments.is_empty() {
        match crate::store::attachments::persist(&app, &task.id, &[], attachments) {
            Ok(refs) => task.attachments = refs,
            Err(e) => {
                crate::store::attachments::remove_all(&app, &task.id);
                return Err(e);
            }
        }
    }
    // Persist + stamp the monotonic seq; emit the STORED snapshot so the `nc:task`
    // on the wire carries the assigned `seq`, not the unstamped local task.
    let task = store.upsert(&task)?;
    // CRUD observability (#10): id + run-shaping metadata only — never the title or
    // description (those can carry user content; the PII discipline stays clean).
    tracing::info!(
        target: "nightcore",
        task_id = %task.id,
        kind = task.kind.as_wire(),
        run_mode = ?task.run_mode,
        "task created"
    );
    let _ = app.emit(TASK_EVENT, &task);
    Ok(task)
}

/// Decompose §B: convert ONE proposed sub-task of a decompose task into a real
/// board task. Mints a child `Build` task (active-project defaults, with
/// `parent_task_id` pointing back at the decompose task), marks the proposal
/// `Converted` + linked, and emits `nc:task` for both the new child and the
/// updated parent. Returns the updated PARENT task (the panel's source of truth).
///
/// Idempotent and race-safe, mirroring `convert_finding_to_task`: a proposal
/// already converted to a still-existing task mints nothing; a lost compare-and-set
/// race rolls back the duplicate child it had minted.
#[tauri::command]
pub fn convert_subtask(
    app: AppHandle,
    store: State<'_, TaskStore>,
    settings: State<'_, crate::settings::SettingsStore>,
    projects: State<'_, crate::project::ProjectStore>,
    parent_id: String,
    subtask_id: String,
) -> Result<Task, String> {
    convert_one(&app, &store, &settings, &projects, &parent_id, &subtask_id)?;
    store
        .get(&parent_id)
        .ok_or_else(|| format!("no decompose task with id {parent_id}"))
}

/// Decompose §B: convert EVERY still-open proposed sub-task of a decompose task.
/// One sub-task's failure is logged and skipped so the rest still convert (mirrors
/// the Insight bulk-convert). Returns the updated PARENT task.
#[tauri::command]
pub fn convert_all_subtasks(
    app: AppHandle,
    store: State<'_, TaskStore>,
    settings: State<'_, crate::settings::SettingsStore>,
    projects: State<'_, crate::project::ProjectStore>,
    parent_id: String,
) -> Result<Task, String> {
    let parent = store
        .get(&parent_id)
        .ok_or_else(|| format!("no decompose task with id {parent_id}"))?;
    let open_ids: Vec<String> = parent
        .proposed_subtasks
        .iter()
        .filter(|s| s.status == SubtaskStatus::Open)
        .map(|s| s.id.clone())
        .collect();
    for id in open_ids {
        if let Err(e) = convert_one(&app, &store, &settings, &projects, &parent_id, &id) {
            tracing::error!(target: "nightcore", parent_id = %parent_id, subtask_id = %id, error = %e, "convert sub-task failed; continuing");
        }
    }
    store
        .get(&parent_id)
        .ok_or_else(|| format!("no decompose task with id {parent_id}"))
}

/// Apply a partial update to a task, bump `updated_at`, persist, and emit
/// `nc:task`. Errors if the id is unknown.
#[tauri::command]
pub fn update_task(
    app: AppHandle,
    store: State<'_, TaskStore>,
    id: String,
    patch: TaskPatch,
) -> Result<Task, String> {
    let task = store.mutate(&id, |task| patch.apply(task))?;
    tracing::debug!(target: "nightcore", task_id = %id, "task updated");
    let _ = app.emit(TASK_EVENT, &task);
    Ok(task)
}

/// Delete a task and remove its JSON file. Also removes the task's transcript
/// directory (M4.7 §C) and, when the task ran in worktree mode, its `nc/<id>`
/// worktree dir + branch (C8 — mirrors the `merge_task` cleanup) so a deleted task
/// leaves no orphaned worktree/branch behind. No-op event; the webview drops the id
/// on the command's success.
#[tauri::command]
pub fn delete_task(app: AppHandle, store: State<'_, TaskStore>, id: String) -> Result<(), String> {
    // Capture the task before removing it so we know whether it had a worktree to
    // clean up (a `branch` chip is only set for worktree-mode runs).
    let task = store.get(&id);
    store.remove(&id)?;
    crate::transcript::remove_transcript(&app, &id);
    crate::store::attachments::remove_all(&app, &id);
    cleanup_task_worktree(&app, &id, task.as_ref());
    tracing::info!(target: "nightcore", task_id = %id, "task deleted");
    Ok(())
}

/// Add image attachments to an existing task (pre-run, from the detail drawer).
/// Persists the files to app-data, appends the refs, and emits `nc:task`. The
/// per-task count is enforced over the existing + incoming set. Errors if the id is
/// unknown.
#[tauri::command]
pub fn add_task_attachments(
    app: AppHandle,
    store: State<'_, TaskStore>,
    id: String,
    attachments: Vec<crate::store::attachments::NewAttachment>,
) -> Result<Task, String> {
    let existing = store
        .get(&id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let new_refs =
        crate::store::attachments::persist(&app, &id, &existing.attachments, attachments)?;
    // Commit the refs; if the task vanished between the read and the write, delete the
    // files we just persisted so a failed add leaves no orphans (mirrors create_task).
    let to_commit = new_refs.clone();
    let result = store.mutate(&id, move |task| task.attachments.extend(to_commit));
    let task = match result {
        Ok(task) => task,
        Err(e) => {
            for att in &new_refs {
                let _ = crate::store::attachments::remove_one(&app, &id, att);
            }
            return Err(e);
        }
    };
    tracing::debug!(target: "nightcore", task_id = %id, "task attachments added");
    let _ = app.emit(TASK_EVENT, &task);
    Ok(task)
}

/// Remove one image attachment from a task by its id: delete the file, drop the ref,
/// and emit `nc:task`. Idempotent on a missing file/ref so a double-remove is safe.
#[tauri::command]
pub fn remove_task_attachment(
    app: AppHandle,
    store: State<'_, TaskStore>,
    id: String,
    attachment_id: String,
) -> Result<Task, String> {
    let task = store
        .get(&id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    if let Some(att) = task.attachments.iter().find(|a| a.id == attachment_id) {
        crate::store::attachments::remove_one(&app, &id, att)?;
    }
    let task = store.mutate(&id, move |task| {
        task.attachments.retain(|a| a.id != attachment_id)
    })?;
    tracing::debug!(target: "nightcore", task_id = %id, "task attachment removed");
    let _ = app.emit(TASK_EVENT, &task);
    Ok(task)
}

/// Read one attachment's bytes as base64 (no `data:` prefix) for display in the
/// detail drawer. The web builds the data URL from the ref's `format`. Errors if the
/// task or attachment id is unknown.
///
/// Reads the attachment file and base64-encodes it (~1.33×) — multi-MB for a large
/// screenshot. A synchronous command does that on the main thread, briefly freezing
/// the WKWebView when the detail drawer opens, so run it on the blocking pool.
#[tauri::command]
pub async fn read_task_attachment(
    app: AppHandle,
    id: String,
    attachment_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_task_attachment_blocking(&app, &id, &attachment_id)
    })
    .await
    .map_err(|e| format!("read attachment failed to run: {e}"))?
}

fn read_task_attachment_blocking(
    app: &AppHandle,
    id: &str,
    attachment_id: &str,
) -> Result<String, String> {
    use tauri::Manager;
    let store = app
        .try_state::<TaskStore>()
        .ok_or("task store unavailable")?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let att = task
        .attachments
        .iter()
        .find(|a| a.id == attachment_id)
        .ok_or_else(|| format!("no attachment with id {attachment_id}"))?;
    crate::store::attachments::read_base64(app, id, att)
}

/// Best-effort cleanup of a deleted task's `nc/<id>` worktree + branch (C8). Only
/// fires for a worktree-mode task with an active project; `main`-mode tasks have no
/// worktree/branch. Mirrors the `merge_task` cleanup order (remove the worktree
/// first so its checked-out branch is free to delete). Failures are logged, never
/// surfaced — the task JSON is already gone, so delete must still succeed.
fn cleanup_task_worktree(app: &AppHandle, id: &str, task: Option<&Task>) {
    use tauri::Manager;
    // Nothing to clean for a main-mode (or vanished) task — it never had a branch.
    let Some(task) = task else { return };
    if !task.run_mode.is_worktree() {
        return;
    }
    let Some(project) = app.state::<crate::project::ProjectStore>().active() else {
        return;
    };
    let project_path = std::path::PathBuf::from(&project.path);
    if let Err(e) = crate::worktree::remove(&project_path, id) {
        tracing::warn!(target: "nightcore", task_id = id, error = %e, "delete: worktree remove failed");
    }
    // Delete the task's actual branch (a picker-chosen name, else `nc/<id>`); guarded
    // so it can never delete the project's base branch.
    let branch = task
        .branch
        .clone()
        .unwrap_or_else(|| crate::worktree::branch_name(id));
    if let Err(e) = crate::worktree::delete_branch_named(&project_path, &branch) {
        tracing::warn!(target: "nightcore", task_id = id, error = %e, "delete: branch delete failed");
    }
}

/// The ids of tasks that are launchable in status (`backlog`/`ready`) but whose
/// dependencies are not all `Done`. Read-only; the board surfaces these as the
/// "blocked" badge and disables their Run action. Fail-closed: a vanished or
/// failed dependency reads as blocked (mirrors [`crate::orchestration::deps::deps_satisfied`]).
#[tauri::command]
pub fn blocked_task_ids(store: State<'_, TaskStore>) -> Result<Vec<String>, String> {
    use crate::orchestration::deps::{index_by_id, is_blocked};
    let tasks = store.list();
    let by_id = index_by_id(&tasks);
    Ok(tasks
        .iter()
        .filter(|t| is_blocked(t, &by_id))
        .map(|t| t.id.clone())
        .collect())
}

/// Manually set a task's status (drag between board columns), persist, and emit
/// `nc:task`. Pure board bookkeeping — worktrees and slots are untouched.
///
/// Guards: the status string is validated against [`TaskStatus`] (unknown values
/// are rejected), and a move INTO `in_progress` is refused — that transition is
/// owned by `run_task`/the coordinator, not a manual drag.
#[tauri::command]
pub fn move_task(
    app: AppHandle,
    store: State<'_, TaskStore>,
    id: String,
    status: String,
) -> Result<Task, String> {
    let task = move_task_inner(&store, &id, &status)?;
    tracing::info!(target: "nightcore", task_id = %id, status = %status, "task moved");
    let _ = app.emit(TASK_EVENT, &task);
    Ok(task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::TaskStatus;

    /// A store rooted at a fresh temp dir, for command-logic tests.
    fn temp_store() -> (TaskStore, tempfile::TempDir) {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let store = TaskStore::load_from(tmp.path().join("tasks"));
        (store, tmp)
    }

    fn seed(store: &TaskStore, status: TaskStatus, deps: &[&str]) -> String {
        let mut t = Task::new("seed".into(), String::new());
        t.status = status;
        t.dependencies = deps.iter().map(|s| s.to_string()).collect();
        let id = t.id.clone();
        store.upsert(&t).expect("seed upsert");
        id
    }

    #[test]
    fn blocked_ids_includes_blocked_and_excludes_satisfied_and_running() {
        use crate::orchestration::deps::{index_by_id, is_blocked};
        let (store, _tmp) = temp_store();

        let done_dep = seed(&store, TaskStatus::Done, &[]);
        let blocked = seed(&store, TaskStatus::Ready, &["ghost"]); // dep missing → blocked
        let satisfied = seed(&store, TaskStatus::Ready, &[&done_dep]); // dep done → not blocked
        let running = seed(&store, TaskStatus::InProgress, &["ghost"]); // not launchable

        // Mirror the command body (which needs an AppHandle the unit test can't build).
        let tasks = store.list();
        let by_id = index_by_id(&tasks);
        let ids: Vec<String> = tasks
            .iter()
            .filter(|t| is_blocked(t, &by_id))
            .map(|t| t.id.clone())
            .collect();

        assert!(
            ids.contains(&blocked),
            "a ready task with an unmet dep is blocked"
        );
        assert!(
            !ids.contains(&satisfied),
            "a ready task with all deps done is not blocked"
        );
        assert!(
            !ids.contains(&running),
            "an in-progress task is never blocked"
        );
        assert!(!ids.contains(&done_dep), "a terminal task is never blocked");
    }
}
