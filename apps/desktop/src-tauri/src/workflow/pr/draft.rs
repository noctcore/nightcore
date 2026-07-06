//! PR message drafting: an AI-drafted (or deterministically fallen-back) title +
//! body for the editable create dialog, plus the base-resolution the draft is
//! computed against.

use serde::Serialize;
use tauri::{AppHandle, Manager};
#[cfg(test)]
use ts_rs::TS;

use crate::git::validate_ref;
use crate::store::TaskStore;
use crate::workflow::merge::require_project;
use crate::workflow::pr_msg;
use crate::worktree;

/// An AI-drafted (or deterministically fallen-back) PR title + markdown body,
/// pre-filled into the editable create dialog — never posted directly.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrDraft.ts"))]
pub struct PrDraft {
    pub title: String,
    pub body: String,
}

/// Draft a PR title/body for a task via the `claude -p` one-shot
/// ([`pr_msg::draft_for`]), falling back to the deterministic pair (task title +
/// task description) on any failure — the command itself never errors on a
/// drafting failure, only on a missing task/project or an invalid `base`. Run
/// when the create dialog opens, so `create_pr_task` never blocks on `claude`.
/// `base` lets the dialog RE-draft against a picker-chosen base (the draft
/// describes `git diff <base>...HEAD`, so a base switch changes the facts);
/// `None` keeps the default resolution (task base → project branch).
#[tauri::command]
pub async fn draft_pr_message(
    app: AppHandle,
    id: String,
    base: Option<String>,
) -> Result<PrDraft, String> {
    // The drafting pass spawns `claude -p` (up to a 30s timeout) plus git reads —
    // blocking work that must not run on the UI thread (the WKWebView rule).
    tauri::async_runtime::spawn_blocking(move || draft_pr_message_blocking(&app, &id, base))
        .await
        .map_err(|e| format!("PR message drafting failed to run: {e}"))?
}

/// The blocking body of `draft_pr_message`.
fn draft_pr_message_blocking(
    app: &AppHandle,
    id: &str,
    base_arg: Option<String>,
) -> Result<PrDraft, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(app)?;
    let project_path = std::path::PathBuf::from(&project.path);
    let dir = worktree::worktree_path(&project_path, id);
    let base = resolve_draft_base(base_arg, task.base_branch.clone(), || {
        worktree::base_branch(&project_path)
    })?;
    let drafted = if dir.exists() {
        pr_msg::draft_for(&store, &dir, &task, &base)
    } else {
        None
    };
    Ok(drafted.unwrap_or_else(|| PrDraft {
        title: task.title.clone(),
        body: task.description.clone(),
    }))
}

/// Resolve the base a draft is computed against: an explicit picker base wins
/// (validated — it reaches `git diff` argv inside `draft_for`), else the task's
/// stored base, else the project's current branch. A blank/whitespace explicit
/// base counts as "not provided". Pure, unit-testable.
fn resolve_draft_base(
    base_arg: Option<String>,
    task_base: Option<String>,
    project_base: impl FnOnce() -> String,
) -> Result<String, String> {
    match base_arg.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => {
            validate_ref(b)?;
            Ok(b.to_string())
        }
        None => Ok(task_base.unwrap_or_else(project_base)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_draft_base_prefers_explicit_then_task_then_project() {
        // No explicit base: the task's stored base wins, else the project's.
        let base = resolve_draft_base(None, Some("develop".into()), || "main".into());
        assert_eq!(base.as_deref(), Ok("develop"));
        let base = resolve_draft_base(None, None, || "main".into());
        assert_eq!(base.as_deref(), Ok("main"));

        // An explicit picker base beats both (the re-draft-on-base-change path).
        let base = resolve_draft_base(Some("release/2.0".into()), Some("develop".into()), || {
            "main".into()
        });
        assert_eq!(base.as_deref(), Ok("release/2.0"));

        // Blank/whitespace explicit base counts as "not provided".
        let base = resolve_draft_base(Some("   ".into()), Some("develop".into()), || "main".into());
        assert_eq!(base.as_deref(), Ok("develop"));

        // An option-injection base is rejected before it can reach git argv.
        let err = resolve_draft_base(Some("--force".into()), None, || "main".into())
            .expect_err("a dash base is rejected");
        assert!(err.contains("invalid branch/base name"), "err: {err}");
    }
}
