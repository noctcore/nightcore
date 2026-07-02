//! TaskStore-facing CRUD helpers behind the task command handlers.
//!
//! The non-`#[tauri::command]` persistence helpers the handlers in
//! [`super`](crate::store::task) call: the decompose convert flow
//! ([`convert_one`]) and the status-move validation
//! ([`move_task_inner`]/[`parse_status`]). No engine up-calls live here — those
//! stay with the handlers in `mod.rs`.

use tauri::{AppHandle, Emitter};

use crate::store::TaskStore;

use super::create::{build_new_task, CreateInputs};
use super::model::{sanitize_minted_title, SubtaskStatus, Task, TaskKind, TaskStatus};
use super::TASK_EVENT;

/// Mint one child task from a proposed sub-task and atomically mark the proposal
/// converted. Shared by [`convert_subtask`] and [`convert_all_subtasks`].
pub(crate) fn convert_one(
    app: &AppHandle,
    store: &TaskStore,
    settings: &crate::settings::SettingsStore,
    projects: &crate::project::ProjectStore,
    parent_id: &str,
    subtask_id: &str,
) -> Result<(), String> {
    let parent = store
        .get(parent_id)
        .ok_or_else(|| format!("no decompose task with id {parent_id}"))?;
    let sub = parent
        .proposed_subtasks
        .iter()
        .find(|s| s.id == subtask_id)
        .cloned()
        .ok_or_else(|| format!("no proposed sub-task {subtask_id} on task {parent_id}"))?;
    // Whether the proposal's existing link still points at a live task. A proposal
    // is eligible to (re)convert when it is `Open` OR `Converted` but its linked
    // child was deleted out from under it (`dead_link`) — without the latter, a
    // deleted child would strand the proposal as a permanent dead "task" badge.
    let dead_link = sub.status == SubtaskStatus::Converted
        && match sub.linked_task_id.as_deref() {
            Some(existing) => store.get(existing).is_none(),
            None => true,
        };
    // Fast-path idempotency: a proposal already linked to a LIVE task converts
    // nothing (covers the common re-click).
    if sub.status == SubtaskStatus::Converted && !dead_link {
        return Ok(());
    }
    // Mint the child FIRST (a crash before linking leaves an unlinked proposal —
    // retryable — rather than a proposal pointing at a non-existent task). The
    // child is a plain `Build` task scoped to the active project, stamped with the
    // decompose task as its parent.
    let project_id = projects.active().map(|p| p.id);
    let mut child = build_new_task(
        settings,
        project_id.as_deref(),
        sanitize_minted_title(&sub.title, "Untitled sub-task"),
        sub.prompt.clone(),
        CreateInputs::default(),
    );
    child.kind = TaskKind::Build;
    child.parent_task_id = Some(parent_id.to_string());
    let child = store.upsert(&child)?;
    // Compare-and-set the proposal status under the store lock: flip to `Converted`
    // and link the new child if the proposal is still eligible (`Open`, or a
    // dead-linked `Converted` we observed above). `won` tells us whether we, not a
    // concurrent convert, performed the flip.
    let mut won = false;
    let cas = store.mutate(parent_id, |task| {
        if let Some(s) = task
            .proposed_subtasks
            .iter_mut()
            .find(|s| s.id == subtask_id)
        {
            let eligible = s.status == SubtaskStatus::Open
                || (s.status == SubtaskStatus::Converted && dead_link);
            if eligible {
                s.status = SubtaskStatus::Converted;
                s.linked_task_id = Some(child.id.clone());
                won = true;
            }
        }
    });
    let updated_parent = match cas {
        Ok(parent) => parent,
        Err(e) => {
            // The parent vanished or its persist failed: roll back the orphan child
            // we minted so a retry is clean (mirrors `convert_finding_to_task`).
            let _ = store.remove(&child.id);
            return Err(e);
        }
    };
    if !won {
        // Another convert won the race (or the proposal vanished). Roll back the
        // duplicate child we minted so a losing race leaves no orphan board task.
        let _ = store.remove(&child.id);
        return Ok(());
    }
    let _ = app.emit(TASK_EVENT, &child);
    let _ = app.emit(TASK_EVENT, &updated_parent);
    tracing::info!(target: "nightcore", parent_id = %parent_id, subtask_id = %subtask_id, child_id = %child.id, "sub-task converted to task");
    Ok(())
}

/// Parse a wire status string (snake_case, as the bridge sends it) into a
/// [`TaskStatus`], rejecting anything unknown. Reuses the enum's serde mapping so
/// the accepted strings can never drift from the wire contract.
pub(super) fn parse_status(raw: &str) -> Result<TaskStatus, String> {
    serde_json::from_value(serde_json::Value::String(raw.to_string()))
        .map_err(|_| format!("unknown task status: {raw}"))
}

/// The status validation + persistence behind [`move_task`], factored out so the
/// guards are unit-testable without a live `AppHandle`.
pub(crate) fn move_task_inner(store: &TaskStore, id: &str, status: &str) -> Result<Task, String> {
    let status = parse_status(status)?;
    if status == TaskStatus::InProgress {
        return Err("cannot move a task into In Progress — run it instead".to_string());
    }
    // Refuse to drag a live (in-flight / verifying) run between columns — that
    // transition is owned by the coordinator, not a manual move. The check shares
    // the write's lock acquisition so it can't race a concurrent transition.
    store.mutate_if(
        id,
        |task| match task.status {
            TaskStatus::InProgress | TaskStatus::Verifying => {
                Err("cannot move a running task — cancel it first".to_string())
            }
            _ => Ok(()),
        },
        |task| task.status = status,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parse_status_accepts_verifying() {
        assert_eq!(parse_status("verifying").unwrap(), TaskStatus::Verifying);
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
}
