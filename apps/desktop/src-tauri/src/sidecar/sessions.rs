//! The per-task SDK session-store commands (session history + resume).
//!
//! The Claude Agent SDK persists every run as a resumable JSONL under
//! `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. These commands surface that
//! history to the board over the request/reply NDJSON path: each issues a
//! `SurfaceQuery` through [`crate::sidecar::query`] and maps the correlated reply.
//!
//! ## The worktree/cwd resume strategy
//!
//! Nightcore runs each worktree-mode task in its own cwd
//! (`<project>/.nightcore/worktrees/<taskId>`), which keys that run's SDK session
//! storage. Pruning the worktree ORPHANS the session — its JSONL survives, but a
//! `dir`-scoped list can no longer enumerate the gone worktree. So:
//!
//!  - **Per-task transcript reads resolve by UUID with NO `dir`** (the SDK searches
//!    all project dirs), the only PRUNE-SAFE read path.
//!  - **Discovery lists by the project ROOT with `includeWorktrees: true`** to
//!    surface sibling sessions that still have a live worktree.
//!  - **Orphaned detection is Rust-side**: a session whose `cwd` no longer exists on
//!    disk is badged `orphaned`. Its transcript stays readable, but RESUME is
//!    refused (decision: resume is offered only when the cwd still exists — we never
//!    re-create a pruned worktree to resume).

use std::path::Path;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::project::ProjectStore;
use crate::store::TaskStore;

use super::commands::run_task;
use super::query;

/// One past SDK session for the board's per-task history view. Mirrors the wire
/// `SessionInfo` (the SDK's metadata) plus the Rust-computed `orphaned` flag: the
/// web can't `stat` the filesystem, so the core decides whether the session's cwd
/// still exists. Exported to TS as `SessionInfo` for the bridge.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, rename = "SessionInfo", export_to = "SessionInfo.ts"))]
pub struct SessionInfoView {
    /// SDK session UUID.
    pub sdk_session_id: String,
    /// Display title: custom title, auto-summary, or first prompt.
    pub summary: String,
    /// Last-modified time, ms since epoch.
    pub last_modified: f64,
    /// File size in bytes (local JSONL only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size: Option<f64>,
    /// User-set title via `/rename`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<String>,
    /// First meaningful user prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    /// Git branch at the end of the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    /// Working directory the session ran in (the cwd that keys its storage).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// User-set session tag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    /// Creation time, ms since epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<f64>,
    /// Rust-computed: the session's `cwd` no longer exists on disk (its worktree
    /// was pruned). The transcript is still readable, but resume is refused. A
    /// session with no `cwd` is treated as NOT orphaned (it ran in a stable place).
    pub orphaned: bool,
}

/// One transcript message for the board's per-task history view. Mirrors the wire
/// `SessionMessage`. Exported to TS as `SessionMessage` for the bridge.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(
    test,
    ts(export, rename = "SessionMessage", export_to = "SessionMessage.ts")
)]
pub struct SessionMessageView {
    /// `user` / `assistant` / `system`.
    pub r#type: String,
    pub uuid: String,
    /// SDK session UUID this message belongs to.
    pub session_id: String,
    /// Raw Anthropic message JSON, forwarded opaquely (rendered by the web).
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub message: serde_json::Map<String, Value>,
    /// Parent tool-use id for a tool-result message, or `null`.
    pub parent_tool_use_id: Option<String>,
}

/// Whether a session's `cwd` no longer exists on disk (worktree pruned). A session
/// that recorded no `cwd` is not orphaned — it has no path that could have been
/// pruned. Pure so it is unit-testable without touching the SDK.
fn is_orphaned(cwd: Option<&str>) -> bool {
    match cwd {
        Some(path) => !Path::new(path).exists(),
        None => false,
    }
}

/// The active project's root path, used as the `dir` for the discovery list (with
/// `includeWorktrees: true` the SDK fans out to every live worktree under it).
fn active_project_root(app: &AppHandle) -> Option<String> {
    app.state::<ProjectStore>().active().map(|p| p.path)
}

/// Extract the `error` string from a `query-result` reply for an `ok: false` case.
fn reply_error(reply: &Value) -> String {
    reply
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("session query failed")
        .to_string()
}

/// List the SDK sessions discoverable for a task's project (M-resume §1). Lists by
/// the active project ROOT with `includeWorktrees: true`, so every live-worktree
/// session is surfaced; a pruned-worktree session won't appear here (read it by
/// UUID via [`get_task_session_messages`] instead). Each entry is tagged `orphaned`
/// Rust-side. Returns an empty list when there is no active project.
#[tauri::command]
pub async fn list_task_sessions(
    app: AppHandle,
    task_id: String,
) -> Result<Vec<SessionInfoView>, String> {
    let _ = task_id; // reserved for a future per-task dir scoping; project-root for now
    let Some(dir) = active_project_root(&app) else {
        return Ok(Vec::new());
    };

    let surface_query = crate::contracts::SurfaceQuery::ListSessions {
        // `requestId` is overwritten by the provider with a fresh uuid.
        request_id: String::new(),
        dir: Some(dir),
        limit: None,
        offset: None,
        include_worktrees: Some(true),
    };
    let reply = query(&app, surface_query).await?;
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(reply_error(&reply));
    }

    let sessions: Vec<crate::contracts::SessionInfo> = match reply.get("sessions") {
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    Ok(sessions.into_iter().map(to_view).collect())
}

/// Read one session's transcript by its SDK session UUID (M-resume §2). Issues the
/// query with NO `dir` — the PRUNE-SAFE path that finds the JSONL even after its
/// worktree is gone, so an orphaned session's transcript stays viewable.
#[tauri::command]
pub async fn get_task_session_messages(
    app: AppHandle,
    sdk_session_id: String,
) -> Result<Vec<SessionMessageView>, String> {
    let surface_query = crate::contracts::SurfaceQuery::GetSessionMessages {
        request_id: String::new(),
        sdk_session_id,
        dir: None,
        limit: None,
        offset: None,
        include_system_messages: None,
    };
    let reply = query(&app, surface_query).await?;
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(reply_error(&reply));
    }
    match reply.get("messages") {
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| e.to_string()),
        None => Ok(Vec::new()),
    }
}

/// Read one session's metadata by UUID (with NO `dir`, prune-safe). Used by
/// [`resume_session`] to check the session's cwd before relaunching, and available
/// for a single-session refresh. Returns `None` when the session is not found.
async fn fetch_session_info(
    app: &AppHandle,
    sdk_session_id: &str,
) -> Result<Option<SessionInfoView>, String> {
    let surface_query = crate::contracts::SurfaceQuery::GetSessionInfo {
        request_id: String::new(),
        sdk_session_id: sdk_session_id.to_string(),
        dir: None,
    };
    let reply = query(app, surface_query).await?;
    if reply.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(reply_error(&reply));
    }
    match reply.get("info") {
        Some(Value::Null) | None => Ok(None),
        Some(v) => {
            let info: crate::contracts::SessionInfo =
                serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
            Ok(Some(to_view(info)))
        }
    }
}

/// Resume a chosen historical session (M-resume §3). Writes the chosen UUID onto
/// `task.sdk_session_id` (the resume id `build_guardrails` reads), then reuses the
/// EXISTING `run_task` path so the relaunch threads `resumeSessionId` through with
/// NO new resume plumbing. Refuses an ORPHANED session: resume is offered only when
/// the session's cwd still exists — we never re-create a pruned worktree.
#[tauri::command]
pub async fn resume_session(
    app: AppHandle,
    store: State<'_, TaskStore>,
    task_id: String,
    sdk_session_id: String,
) -> Result<(), String> {
    // Refuse a resume of an orphaned session: its cwd is gone, so the SDK would
    // start a fresh session instead of reattaching. Read the session's metadata
    // (prune-safe, no dir) and check its cwd exists.
    if let Some(info) = fetch_session_info(&app, &sdk_session_id).await? {
        if info.orphaned {
            return Err(
                "cannot resume an orphaned session — its worktree was pruned, so its history is view-only".to_string(),
            );
        }
    }

    // Point the task at the chosen session UUID so the existing run path resumes
    // THIS session (not whatever ran last). Persist + emit `nc:task`.
    let updated = store.mutate(&task_id, |t| {
        t.sdk_session_id = Some(sdk_session_id.clone());
    })?;
    {
        use tauri::Emitter;
        let _ = app.emit(crate::task::TASK_EVENT, &updated);
    }

    // Reuse the manual run path verbatim: it leases a slot, resolves the worktree,
    // marks the task in-progress, and dispatches `start-session` with the resume id.
    run_task(app, task_id).await
}

/// Rename a past session (sets its custom title). The web edits the title on a
/// history row; the change persists into the session's JSONL via the SDK.
#[tauri::command]
pub async fn rename_session(
    app: AppHandle,
    sdk_session_id: String,
    title: String,
) -> Result<(), String> {
    let surface_query = crate::contracts::SurfaceQuery::RenameSession {
        request_id: String::new(),
        sdk_session_id,
        title,
        dir: None,
    };
    let reply = query(&app, surface_query).await?;
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(reply_error(&reply))
    }
}

/// Tag a past session, or clear its tag when `tag` is `null`. The web sets/clears a
/// tag on a history row.
#[tauri::command]
pub async fn tag_session(
    app: AppHandle,
    sdk_session_id: String,
    tag: Option<String>,
) -> Result<(), String> {
    let surface_query = crate::contracts::SurfaceQuery::TagSession {
        request_id: String::new(),
        sdk_session_id,
        tag,
        dir: None,
    };
    let reply = query(&app, surface_query).await?;
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(reply_error(&reply))
    }
}

/// Map a wire `SessionInfo` (from the sidecar reply) to the board view, computing
/// the `orphaned` flag from whether the session's `cwd` still exists on disk.
fn to_view(info: crate::contracts::SessionInfo) -> SessionInfoView {
    let orphaned = is_orphaned(info.cwd.as_deref());
    SessionInfoView {
        sdk_session_id: info.sdk_session_id,
        summary: info.summary,
        last_modified: info.last_modified,
        file_size: info.file_size,
        custom_title: info.custom_title,
        first_prompt: info.first_prompt,
        git_branch: info.git_branch,
        cwd: info.cwd,
        tag: info.tag,
        created_at: info.created_at,
        orphaned,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orphaned_when_cwd_is_missing() {
        // A session whose recorded cwd no longer exists on disk is orphaned.
        assert!(is_orphaned(Some("/nope/this/path/does/not/exist/abc123")));
    }

    #[test]
    fn not_orphaned_for_an_existing_cwd() {
        // The repo root (the test's cwd) certainly exists.
        let here = std::env::current_dir().unwrap();
        assert!(!is_orphaned(Some(here.to_str().unwrap())));
    }

    #[test]
    fn not_orphaned_when_cwd_is_absent() {
        // No recorded cwd ⇒ nothing was pruned ⇒ not orphaned.
        assert!(!is_orphaned(None));
    }

    #[test]
    fn to_view_computes_orphaned_from_cwd() {
        let info = crate::contracts::SessionInfo {
            sdk_session_id: "u".into(),
            summary: "s".into(),
            last_modified: 1.0,
            file_size: None,
            custom_title: None,
            first_prompt: None,
            git_branch: Some("nc/task-1".into()),
            cwd: Some("/definitely/not/here/xyz".into()),
            tag: None,
            created_at: None,
        };
        let view = to_view(info);
        assert!(view.orphaned, "a missing cwd marks the view orphaned");
        assert_eq!(view.git_branch.as_deref(), Some("nc/task-1"));
    }
}
