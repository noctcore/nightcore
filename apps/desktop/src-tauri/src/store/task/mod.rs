//! The task model facade + the CRUD commands over the task registry.
//!
//! A `Task` is the unit of work the studio orchestrates: a prompt with a
//! lifecycle. M1 owns creating, editing, deleting, listing, and persisting
//! tasks; running one through the sidecar lives in `sidecar.rs`. Every mutation
//! goes through the [`TaskStore`](crate::store::TaskStore) (persist) and emits
//! `nc:task` (the full task) so the webview can upsert its board by id.
//!
//! The data model lives in [`model`]; the TaskStore-facing CRUD helpers in
//! [`crud`]; this file keeps the `#[tauri::command]` handlers (which still hold the
//! engine up-calls `lib.rs` registers as `task::*`).

mod crud;
mod model;

// Module facade: preserve the historical `crate::task::*` paths after the god-file
// split so call sites elsewhere (`lib.rs` `generate_handler!`, `contracts`,
// `store/mod.rs`, the `sidecar`/`workflow`/`orchestration` modules) keep resolving
// unchanged. Mirrors the glob-reexport pattern in `sidecar/mod.rs`.
// `crud` holds only `pub(super)` helpers consumed by the handlers below — bring
// them into scope with a private `use` (nothing outside `task` references them).
use crud::*;
pub use model::*;

use tauri::{AppHandle, Emitter, State};

use crate::store::TaskStore;

/// The Tauri event carrying a single task to the webview. The UI upserts its
/// board state by `task.id`, so every create/update/status change re-emits this.
pub const TASK_EVENT: &str = "nc:task";

// --- Commands ---------------------------------------------------------------

/// All tasks currently in the registry (unordered; the webview groups by status).
#[tauri::command]
pub fn list_tasks(store: State<'_, TaskStore>) -> Result<Vec<Task>, String> {
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
    let existing = store.get(&id).ok_or_else(|| format!("no task with id {id}"))?;
    let new_refs = crate::store::attachments::persist(&app, &id, &existing.attachments, attachments)?;
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
    let task = store.get(&id).ok_or_else(|| format!("no task with id {id}"))?;
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
#[tauri::command]
pub fn read_task_attachment(
    app: AppHandle,
    store: State<'_, TaskStore>,
    id: String,
    attachment_id: String,
) -> Result<String, String> {
    let task = store.get(&id).ok_or_else(|| format!("no task with id {id}"))?;
    let att = task
        .attachments
        .iter()
        .find(|a| a.id == attachment_id)
        .ok_or_else(|| format!("no attachment with id {attachment_id}"))?;
    crate::store::attachments::read_base64(&app, &id, att)
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
    if let Err(e) = crate::orchestration::worktree::remove(&project_path, id) {
        tracing::warn!(target: "nightcore", task_id = id, error = %e, "delete: worktree remove failed");
    }
    if let Err(e) = crate::orchestration::worktree::delete_branch(&project_path, id) {
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

    #[test]
    fn status_serializes_snake_case() {
        // The TS bridge and on-disk JSON depend on these exact wire strings.
        assert_eq!(
            serde_json::to_string(&TaskStatus::InProgress).unwrap(),
            "\"in_progress\""
        );
        assert_eq!(
            serde_json::to_string(&TaskStatus::WaitingApproval).unwrap(),
            "\"waiting_approval\""
        );
        assert_eq!(
            serde_json::to_string(&TaskStatus::Backlog).unwrap(),
            "\"backlog\""
        );
        // M4: the verification phase status.
        assert_eq!(
            serde_json::to_string(&TaskStatus::Verifying).unwrap(),
            "\"verifying\""
        );
    }

    #[test]
    fn status_round_trips_through_serde() {
        for status in [
            TaskStatus::Backlog,
            TaskStatus::Ready,
            TaskStatus::InProgress,
            TaskStatus::Verifying,
            TaskStatus::WaitingApproval,
            TaskStatus::Done,
            TaskStatus::Failed,
        ] {
            let json = serde_json::to_string(&status).unwrap();
            let back: TaskStatus = serde_json::from_str(&json).unwrap();
            assert_eq!(status, back, "status must survive a serde round-trip");
        }
    }

    #[test]
    fn task_serializes_camel_case() {
        // Field names must be camelCase for the TS bridge / contract.
        let task = Task::new("t".into(), String::new());
        let value: serde_json::Value = serde_json::to_value(&task).unwrap();
        let obj = value.as_object().unwrap();
        for key in [
            "createdAt",
            "updatedAt",
            "sessionId",
            "costUsd",
            "branch",
            "parentTaskId",
            "proposedSubtasks",
        ] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }
    }

    #[test]
    fn m3_fields_default_and_round_trip() {
        let task = Task::new("t".into(), String::new());
        assert!(task.plan.is_none(), "plan defaults to None");
        assert!(
            !task.committed && !task.merged && !task.conflict,
            "flags default false"
        );

        let value: serde_json::Value = serde_json::to_value(&task).unwrap();
        let obj = value.as_object().unwrap();
        for key in ["plan", "committed", "merged", "conflict"] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }

        // An older on-disk task without the M3 flags still deserializes (serde
        // default), so existing task files aren't broken.
        let legacy = r#"{"id":"x","title":"t","description":"","status":"backlog",
            "dependencies":[],"model":null,"branch":null,"createdAt":1,"updatedAt":1,
            "sessionId":null,"summary":null,"error":null,"costUsd":null}"#;
        let back: Task = serde_json::from_str(legacy).expect("legacy task deserializes");
        assert!(back.plan.is_none() && !back.committed && !back.merged && !back.conflict);
    }

    #[test]
    fn attachments_default_and_round_trip() {
        let task = Task::new("t".into(), String::new());
        assert!(task.attachments.is_empty(), "attachments default to empty");

        // The camelCase key is present on serialize.
        let value: serde_json::Value = serde_json::to_value(&task).unwrap();
        assert!(value.as_object().unwrap().contains_key("attachments"));

        // A legacy task JSON written before the field existed still loads (serde
        // default → empty list), so existing task files aren't broken.
        let legacy = r#"{"id":"x","title":"t","description":"","status":"backlog",
            "dependencies":[],"model":null,"branch":null,"createdAt":1,"updatedAt":1,
            "sessionId":null,"summary":null,"error":null,"costUsd":null}"#;
        let back: Task = serde_json::from_str(legacy).expect("legacy task deserializes");
        assert!(back.attachments.is_empty(), "missing attachments → empty list");

        // A populated attachments list round-trips field-for-field.
        let mut populated = Task::new("t".into(), String::new());
        populated.attachments = vec![TaskAttachment {
            id: "img-1".into(),
            filename: "shot.png".into(),
            format: "png".into(),
            size: 2048,
        }];
        let json = serde_json::to_string(&populated).unwrap();
        let restored: Task = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.attachments.len(), 1);
        assert_eq!(restored.attachments[0].id, "img-1");
        assert_eq!(restored.attachments[0].format, "png");
        assert_eq!(restored.attachments[0].size, 2048);
    }

    #[test]
    fn m4_fields_default_and_round_trip() {
        let task = Task::new("t".into(), String::new());
        assert_eq!(task.kind, TaskKind::Build, "kind defaults to Build");
        assert!(!task.verified, "verified defaults false");
        assert!(task.review.is_none(), "review defaults None");
        assert_eq!(task.fix_attempts, 0, "fix_attempts defaults 0");

        let value: serde_json::Value = serde_json::to_value(&task).unwrap();
        let obj = value.as_object().unwrap();
        for key in ["kind", "verified", "review", "fixAttempts"] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }
        assert_eq!(
            obj["kind"],
            serde_json::json!("build"),
            "kind serializes snake_case"
        );

        // A legacy (pre-M4) task without any of the four new fields still loads,
        // defaulting each — existing task files aren't broken.
        let legacy = r#"{"id":"x","title":"t","description":"","status":"backlog",
            "dependencies":[],"model":null,"branch":null,"createdAt":1,"updatedAt":1,
            "sessionId":null,"summary":null,"error":null,"costUsd":null,
            "plan":null,"committed":false,"merged":false,"conflict":false}"#;
        let back: Task = serde_json::from_str(legacy).expect("legacy task deserializes");
        assert_eq!(back.kind, TaskKind::Build);
        assert!(!back.verified && back.review.is_none() && back.fix_attempts == 0);
    }

    #[test]
    fn run_mode_defaults_to_main_and_is_serde_additive() {
        // A fresh task and the enum default are `main` (worktrees are opt-in).
        let task = Task::new("t".into(), String::new());
        assert_eq!(task.run_mode, RunMode::Main, "run_mode defaults to Main");
        assert!(!task.run_mode.is_worktree());
        assert_eq!(RunMode::default(), RunMode::Main);

        // It serializes camelCase + snake_case wire (`runMode: "main"`).
        let value: serde_json::Value = serde_json::to_value(&task).unwrap();
        let obj = value.as_object().unwrap();
        assert!(obj.contains_key("runMode"), "missing camelCase key runMode");
        assert_eq!(obj["runMode"], serde_json::json!("main"));

        // A legacy task (M4-era, no `run_mode` at all) loads as `main` — serde
        // default — so existing task files aren't broken (the pinning guarantee).
        let legacy = r#"{"id":"x","title":"t","description":"","status":"backlog",
            "dependencies":[],"model":null,"branch":null,"createdAt":1,"updatedAt":1,
            "sessionId":null,"summary":null,"error":null,"costUsd":null,
            "plan":null,"committed":false,"merged":false,"conflict":false,
            "kind":"build","verified":false,"review":null,"fixAttempts":0}"#;
        let back: Task = serde_json::from_str(legacy).expect("legacy task deserializes");
        assert_eq!(
            back.run_mode,
            RunMode::Main,
            "a task with no run_mode loads as Main"
        );
    }

    #[test]
    fn run_mode_round_trips_and_is_snake_case() {
        for mode in [RunMode::Main, RunMode::Worktree] {
            let json = serde_json::to_string(&mode).unwrap();
            let back: RunMode = serde_json::from_str(&json).unwrap();
            assert_eq!(mode, back, "run_mode must survive a serde round-trip");
        }
        assert_eq!(serde_json::to_string(&RunMode::Main).unwrap(), "\"main\"");
        assert_eq!(
            serde_json::to_string(&RunMode::Worktree).unwrap(),
            "\"worktree\""
        );
    }

    #[test]
    fn patch_sets_run_mode_when_present() {
        let mut task = Task::new("t".into(), String::new());
        assert_eq!(task.run_mode, RunMode::Main);
        let patch: TaskPatch = serde_json::from_str(r#"{"runMode":"worktree"}"#).unwrap();
        patch.apply(&mut task);
        assert_eq!(task.run_mode, RunMode::Worktree);
    }

    #[test]
    fn with_run_mode_sets_the_mode() {
        let task = Task::new("t".into(), String::new()).with_run_mode(RunMode::Worktree);
        assert_eq!(task.run_mode, RunMode::Worktree);
    }

    #[test]
    fn task_kind_round_trips_and_is_snake_case() {
        for kind in [
            TaskKind::Build,
            TaskKind::Research,
            TaskKind::Review,
            TaskKind::Decompose,
            TaskKind::Tdd,
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{}\"", kind.as_wire()));
            let back: TaskKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, back, "kind must survive a serde round-trip");
        }
        // The new test-first kind wires as `tdd`.
        assert_eq!(TaskKind::Tdd.as_wire(), "tdd");
    }

    #[test]
    fn decompose_fields_default_and_are_serde_additive() {
        // A fresh task carries no parent and no proposed sub-tasks.
        let task = Task::new("t".into(), String::new());
        assert!(task.parent_task_id.is_none(), "parent_task_id defaults None");
        assert!(
            task.proposed_subtasks.is_empty(),
            "proposed_subtasks defaults empty"
        );

        // A legacy task JSON written before these fields existed still loads,
        // defaulting both — existing task files aren't broken.
        let legacy = r#"{"id":"x","title":"t","description":"","status":"backlog",
            "dependencies":[],"model":null,"branch":null,"createdAt":1,"updatedAt":1,
            "sessionId":null,"summary":null,"error":null,"costUsd":null,
            "plan":null,"committed":false,"merged":false,"conflict":false,
            "kind":"build","verified":false,"review":null,"fixAttempts":0}"#;
        let back: Task = serde_json::from_str(legacy).expect("legacy task deserializes");
        assert!(back.parent_task_id.is_none() && back.proposed_subtasks.is_empty());

        // A populated proposal round-trips field-for-field with camelCase keys.
        let mut populated = Task::new("d".into(), String::new());
        populated.kind = TaskKind::Decompose;
        populated.proposed_subtasks = vec![ProposedSubtask {
            id: "s-1".into(),
            title: "Add the widget".into(),
            prompt: "Build the widget component".into(),
            status: SubtaskStatus::Converted,
            linked_task_id: Some("child-9".into()),
        }];
        let value = serde_json::to_value(&populated).unwrap();
        let sub = &value["proposedSubtasks"][0];
        assert_eq!(sub["id"], serde_json::json!("s-1"));
        assert_eq!(sub["status"], serde_json::json!("converted"));
        assert_eq!(sub["linkedTaskId"], serde_json::json!("child-9"));
        let restored: Task = serde_json::from_value(value).unwrap();
        assert_eq!(restored.proposed_subtasks[0].status, SubtaskStatus::Converted);
        assert_eq!(
            restored.proposed_subtasks[0].linked_task_id.as_deref(),
            Some("child-9")
        );
    }

    #[test]
    fn patch_sets_kind_when_present() {
        let mut task = Task::new("t".into(), String::new());
        assert_eq!(task.kind, TaskKind::Build);
        let patch: TaskPatch = serde_json::from_str(r#"{"kind":"research"}"#).unwrap();
        patch.apply(&mut task);
        assert_eq!(task.kind, TaskKind::Research);
    }

    #[test]
    fn parse_status_accepts_verifying() {
        assert_eq!(parse_status("verifying").unwrap(), TaskStatus::Verifying);
    }

    #[test]
    fn branch_defaults_to_none_and_round_trips() {
        let mut task = Task::new("t".into(), String::new());
        assert!(task.branch.is_none(), "branch defaults to None");

        task.branch = Some("nc/abc-123".into());
        let json = serde_json::to_string(&task).unwrap();
        assert!(
            json.contains("\"branch\":\"nc/abc-123\""),
            "branch serializes camelCase"
        );
        let back: Task = serde_json::from_str(&json).unwrap();
        assert_eq!(back.branch.as_deref(), Some("nc/abc-123"));
    }

    #[test]
    fn parse_status_accepts_wire_strings_and_rejects_unknown() {
        assert_eq!(parse_status("backlog").unwrap(), TaskStatus::Backlog);
        assert_eq!(parse_status("ready").unwrap(), TaskStatus::Ready);
        assert_eq!(parse_status("in_progress").unwrap(), TaskStatus::InProgress);
        assert_eq!(parse_status("done").unwrap(), TaskStatus::Done);
        let err = parse_status("nope").expect_err("unknown status must error");
        assert!(err.contains("nope"), "error names the bad status");
    }

    #[test]
    fn new_task_defaults_to_backlog() {
        let task = Task::new("title".into(), "desc".into());
        assert_eq!(task.status, TaskStatus::Backlog);
        assert_eq!(task.created_at, task.updated_at);
        assert!(task.dependencies.is_empty());
        assert!(task.model.is_none());
        assert!(task.session_id.is_none());
    }

    #[test]
    fn prompt_omits_blank_description() {
        let task = Task::new("just a title".into(), String::new());
        assert_eq!(task.prompt(), "just a title");
    }

    #[test]
    fn prompt_joins_title_and_description() {
        let task = Task::new("title".into(), "body".into());
        assert_eq!(task.prompt(), "title\n\nbody");
    }

    #[test]
    fn patch_applies_only_present_fields() {
        let mut task = Task::new("orig".into(), "orig-desc".into());
        let patch = TaskPatch {
            title: Some("new".into()),
            status: Some(TaskStatus::Ready),
            ..Default::default()
        };
        patch.apply(&mut task);

        assert_eq!(task.title, "new");
        assert_eq!(task.status, TaskStatus::Ready);
        // Untouched fields keep their original values.
        assert_eq!(task.description, "orig-desc");
        assert!(task.dependencies.is_empty());
    }

    #[test]
    fn m4_7_fields_default_and_round_trip() {
        // M4.7 §A4/§E: `effort` + `permission_mode` default to None and are
        // serde-additive — a legacy task without them still loads.
        let task = Task::new("t".into(), String::new());
        assert!(task.effort.is_none(), "effort defaults to None");
        assert!(
            task.permission_mode.is_none(),
            "permission_mode defaults to None"
        );

        let value: serde_json::Value = serde_json::to_value(&task).unwrap();
        let obj = value.as_object().unwrap();
        for key in ["effort", "permissionMode"] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }

        // A task file from before M4.7 (no `effort`/`permissionMode`) still loads,
        // defaulting both to None — existing task files aren't broken.
        let legacy = r#"{"id":"x","title":"t","description":"","status":"backlog",
            "dependencies":[],"model":null,"branch":null,"createdAt":1,"updatedAt":1,
            "sessionId":null,"summary":null,"error":null,"costUsd":null,
            "plan":null,"committed":false,"merged":false,"conflict":false,
            "kind":"build","runMode":"main","verified":false,"review":null,"fixAttempts":0}"#;
        let back: Task = serde_json::from_str(legacy).expect("legacy task deserializes");
        assert!(back.effort.is_none() && back.permission_mode.is_none());
    }

    #[test]
    fn patch_sets_effort_and_permission_mode_when_present() {
        let mut task = Task::new("t".into(), String::new());
        let patch: TaskPatch =
            serde_json::from_str(r#"{"effort":"high","permissionMode":"ask"}"#).unwrap();
        patch.apply(&mut task);
        assert_eq!(task.effort.as_deref(), Some("high"));
        assert_eq!(task.permission_mode.as_deref(), Some("ask"));

        // An absent field leaves the prior value untouched (same as `model`).
        let absent: TaskPatch = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        absent.apply(&mut task);
        assert_eq!(task.effort.as_deref(), Some("high"));
        assert_eq!(task.permission_mode.as_deref(), Some("ask"));
    }

    #[test]
    fn guardrail_fields_default_and_round_trip() {
        // SDK-guardrails: `max_turns`/`max_budget_usd`/`sdk_session_id` default to
        // None and are serde-additive — a legacy task without them still loads.
        let task = Task::new("t".into(), String::new());
        assert!(task.max_turns.is_none(), "max_turns defaults to None");
        assert!(
            task.max_budget_usd.is_none(),
            "max_budget_usd defaults to None"
        );
        assert!(
            task.sdk_session_id.is_none(),
            "sdk_session_id defaults to None"
        );

        let value: serde_json::Value = serde_json::to_value(&task).unwrap();
        let obj = value.as_object().unwrap();
        for key in ["maxTurns", "maxBudgetUsd", "sdkSessionId"] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }

        // A task file from before the guardrails work (no `maxTurns`/`maxBudgetUsd`/
        // `sdkSessionId`) still loads, defaulting each to None — the pinning
        // guarantee, so existing task files aren't broken.
        let legacy = r#"{"id":"x","title":"t","description":"","status":"backlog",
            "dependencies":[],"model":null,"branch":null,"createdAt":1,"updatedAt":1,
            "sessionId":null,"summary":null,"error":null,"costUsd":null,
            "plan":null,"committed":false,"merged":false,"conflict":false,
            "kind":"build","runMode":"main","verified":false,"review":null,"fixAttempts":0,
            "effort":null,"permissionMode":null}"#;
        let back: Task = serde_json::from_str(legacy).expect("legacy task deserializes");
        assert!(back.max_turns.is_none());
        assert!(back.max_budget_usd.is_none());
        assert!(back.sdk_session_id.is_none());

        // A full round-trip preserves explicitly-set ceilings + a captured SDK id.
        let mut bounded = Task::new("t".into(), String::new());
        bounded.max_turns = Some(42);
        bounded.max_budget_usd = Some(7.5);
        bounded.sdk_session_id = Some("sdk-uuid".into());
        let json = serde_json::to_string(&bounded).unwrap();
        let restored: Task = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.max_turns, Some(42));
        assert_eq!(restored.max_budget_usd, Some(7.5));
        assert_eq!(restored.sdk_session_id.as_deref(), Some("sdk-uuid"));
    }

    #[test]
    fn structure_lock_result_defaults_none_and_is_serde_additive() {
        // Feature #3: the structure-lock result defaults to None and is omitted-safe
        // — a legacy task without it still loads.
        let task = Task::new("t".into(), String::new());
        assert!(
            task.structure_lock_result.is_none(),
            "structure_lock_result defaults to None"
        );

        let value: serde_json::Value = serde_json::to_value(&task).unwrap();
        let obj = value.as_object().unwrap();
        assert!(
            obj.contains_key("structureLockResult"),
            "serializes the camelCase key"
        );

        // A task file from before feature #3 (no `structureLockResult`) still loads,
        // defaulting it to None — the pinning guarantee.
        let legacy = r#"{"id":"x","title":"t","description":"","status":"backlog",
            "dependencies":[],"model":null,"branch":null,"createdAt":1,"updatedAt":1,
            "sessionId":null,"summary":null,"error":null,"costUsd":null,
            "plan":null,"committed":false,"merged":false,"conflict":false,
            "kind":"build","runMode":"main","verified":false,"review":null,"fixAttempts":0,
            "effort":null,"permissionMode":null,"maxTurns":null,"maxBudgetUsd":null,
            "sdkSessionId":null}"#;
        let back: Task = serde_json::from_str(legacy).expect("legacy task deserializes");
        assert!(back.structure_lock_result.is_none());

        // A full round-trip preserves a stored result.
        let mut gated = Task::new("t".into(), String::new());
        gated.structure_lock_result = Some(crate::gauntlet_project::empty_pass());
        let json = serde_json::to_string(&gated).unwrap();
        let restored: Task = serde_json::from_str(&json).unwrap();
        assert!(restored.structure_lock_result.is_some());
        assert!(restored.structure_lock_result.unwrap().passed);
    }

    #[test]
    fn patch_sets_guardrail_ceilings_when_present() {
        let mut task = Task::new("t".into(), String::new());
        let patch: TaskPatch =
            serde_json::from_str(r#"{"maxTurns":10,"maxBudgetUsd":1.5}"#).unwrap();
        patch.apply(&mut task);
        assert_eq!(task.max_turns, Some(10));
        assert_eq!(task.max_budget_usd, Some(1.5));

        // An absent field leaves the prior override untouched (same as `model`).
        let absent: TaskPatch = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        absent.apply(&mut task);
        assert_eq!(task.max_turns, Some(10));
        assert_eq!(task.max_budget_usd, Some(1.5));
    }

    #[test]
    fn build_new_task_inherits_guardrails_from_settings_when_unset() {
        use crate::settings::SettingsStore;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let settings = SettingsStore::load_from(tmp.path().join("config"));
        // A global Settings ceiling is set; the project has its own tighter override.
        settings
            .update_for_test(
                serde_json::from_str(r#"{"maxTurns":150,"maxBudgetUsd":9.0}"#).unwrap(),
            )
            .expect("global ceiling");
        settings
            .update_for_test(serde_json::from_str(r#"{"projectId":"p1","maxTurns":50}"#).unwrap())
            .expect("project override");

        // No explicit per-task ceilings → stamp the resolved Settings defaults.
        let task = build_new_task(
            &settings,
            Some("p1"),
            "t".into(),
            String::new(),
            CreateInputs::default(),
        );
        assert_eq!(
            task.max_turns,
            Some(50),
            "per-project override wins for max_turns"
        );
        assert_eq!(
            task.max_budget_usd,
            Some(9.0),
            "max_budget_usd has no project override → global"
        );

        // Another project with no override falls back to the global ceiling.
        let other = build_new_task(
            &settings,
            Some("other"),
            "t".into(),
            String::new(),
            CreateInputs::default(),
        );
        assert_eq!(other.max_turns, Some(150));
        assert_eq!(other.max_budget_usd, Some(9.0));
    }

    #[test]
    fn build_new_task_explicit_ceilings_win_over_settings() {
        use crate::settings::SettingsStore;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let settings = SettingsStore::load_from(tmp.path().join("config"));
        settings
            .update_for_test(
                serde_json::from_str(r#"{"maxTurns":150,"maxBudgetUsd":9.0}"#).unwrap(),
            )
            .expect("global ceiling");

        // An explicit per-task value always overrides the Settings default.
        let task = build_new_task(
            &settings,
            None,
            "t".into(),
            String::new(),
            CreateInputs {
                max_turns: Some(7),
                max_budget_usd: Some(0.5),
                ..Default::default()
            },
        );
        assert_eq!(task.max_turns, Some(7));
        assert_eq!(task.max_budget_usd, Some(0.5));
    }

    #[test]
    fn build_new_task_stamps_the_picked_kind() {
        use crate::settings::SettingsStore;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let settings = SettingsStore::load_from(tmp.path().join("config"));

        // An explicit kind from the create dialog survives — this is the bug the
        // create path had: `kind` was never threaded, so every new task became Build.
        let task = build_new_task(
            &settings,
            None,
            "t".into(),
            String::new(),
            CreateInputs {
                kind: Some(TaskKind::Decompose),
                ..Default::default()
            },
        );
        assert_eq!(task.kind, TaskKind::Decompose, "the picked kind is stamped");

        // Omitted kind falls back to the Build default (pre-M4 create shape).
        let defaulted = build_new_task(
            &settings,
            None,
            "t".into(),
            String::new(),
            CreateInputs::default(),
        );
        assert_eq!(
            defaulted.kind,
            TaskKind::Build,
            "an omitted kind defaults to Build"
        );
    }

    #[test]
    fn build_new_task_leaves_guardrails_none_when_settings_unset() {
        use crate::settings::SettingsStore;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let settings = SettingsStore::load_from(tmp.path().join("config"));
        // No Settings ceiling and no explicit input → None, so the engine's config
        // default (maxTurns 200, budget uncapped) applies at launch.
        let task = build_new_task(
            &settings,
            None,
            "t".into(),
            String::new(),
            CreateInputs::default(),
        );
        assert!(task.max_turns.is_none());
        assert!(task.max_budget_usd.is_none());
        // The P0 model/effort defaults are still stamped concretely.
        assert_eq!(task.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(task.effort.as_deref(), Some("medium"));
    }

    #[test]
    fn patch_sets_model_when_present() {
        let mut task = Task::new("t".into(), String::new());
        assert!(task.model.is_none());
        let patch: TaskPatch = serde_json::from_str(r#"{"model":"claude-opus-4-8"}"#).unwrap();
        patch.apply(&mut task);
        assert_eq!(task.model.as_deref(), Some("claude-opus-4-8"));
    }

    #[test]
    fn patch_leaves_model_untouched_when_absent() {
        // `Option<String>` flattens an explicit `null` and an absent field to the
        // same `None`, so a patch can SET a model but cannot distinguish "clear
        // it" from "don't touch it" — an absent (or null) `model` is a no-op.
        let mut task = Task::new("t".into(), String::new());
        task.model = Some("claude-opus-4-8".into());

        let absent: TaskPatch = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
        absent.apply(&mut task);
        assert_eq!(task.model.as_deref(), Some("claude-opus-4-8"));

        let explicit_null: TaskPatch = serde_json::from_str(r#"{"model":null}"#).unwrap();
        explicit_null.apply(&mut task);
        assert_eq!(
            task.model.as_deref(),
            Some("claude-opus-4-8"),
            "explicit null is indistinguishable from absent; model is unchanged"
        );
    }

    #[test]
    fn patch_deserializes_camel_case_keys() {
        let patch: TaskPatch =
            serde_json::from_str(r#"{"status":"in_progress","dependencies":["a"]}"#).unwrap();
        assert_eq!(patch.status, Some(TaskStatus::InProgress));
        assert_eq!(patch.dependencies, Some(vec!["a".to_string()]));
        assert!(patch.title.is_none());
    }

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
    fn move_task_inner_sets_status_and_persists() {
        let (store, _tmp) = temp_store();
        let id = seed(&store, TaskStatus::Backlog, &[]);

        let moved = move_task_inner(&store, &id, "ready").expect("move");
        assert_eq!(moved.status, TaskStatus::Ready);
        // Persisted, not just returned.
        assert_eq!(store.get(&id).expect("get").status, TaskStatus::Ready);
    }

    #[test]
    fn move_task_inner_rejects_into_in_progress() {
        let (store, _tmp) = temp_store();
        let id = seed(&store, TaskStatus::Ready, &[]);

        let err = move_task_inner(&store, &id, "in_progress").expect_err("must reject");
        assert!(err.contains("In Progress"), "error explains the guard");
        // The task is untouched.
        assert_eq!(store.get(&id).expect("get").status, TaskStatus::Ready);
    }

    #[test]
    fn move_task_inner_rejects_moving_a_running_task() {
        // A live run (in-flight / verifying) can't be dragged between columns — that
        // transition belongs to the coordinator. The guard shares the write lock.
        for status in [TaskStatus::InProgress, TaskStatus::Verifying] {
            let (store, _tmp) = temp_store();
            let id = seed(&store, status, &[]);
            let err = move_task_inner(&store, &id, "backlog").expect_err("must reject");
            assert!(
                err.contains("running"),
                "error explains the running-task guard: {err}"
            );
            assert_eq!(
                store.get(&id).expect("get").status,
                status,
                "task untouched"
            );
        }
    }

    #[test]
    fn move_task_inner_rejects_unknown_status() {
        let (store, _tmp) = temp_store();
        let id = seed(&store, TaskStatus::Ready, &[]);

        let err = move_task_inner(&store, &id, "garbage").expect_err("must reject");
        assert!(err.contains("garbage"), "error names the bad status");
        assert_eq!(store.get(&id).expect("get").status, TaskStatus::Ready);
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
