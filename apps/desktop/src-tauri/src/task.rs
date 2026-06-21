//! The task model and the CRUD commands over the task registry.
//!
//! A `Task` is the unit of work the studio orchestrates: a prompt with a
//! lifecycle. M1 owns creating, editing, deleting, listing, and persisting
//! tasks; running one through the sidecar lives in `sidecar.rs`. Every mutation
//! goes through the [`TaskStore`](crate::store::TaskStore) (persist) and emits
//! `nc:task` (the full task) so the webview can upsert its board by id.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, State};

use crate::store::TaskStore;

/// The Tauri event carrying a single task to the webview. The UI upserts its
/// board state by `task.id`, so every create/update/status change re-emits this.
pub const TASK_EVENT: &str = "nc:task";

/// Where a task sits in its lifecycle. `ready` and `waiting_approval` are
/// reserved in M1 (defined, not yet produced): the auto-loop and interactive
/// approval that drive them arrive in M2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Backlog,
    Ready,
    InProgress,
    /// M4: a reviewer session is running over the build's worktree diff. The task
    /// holds its slot and worktree across build → verify → fix; only a true
    /// terminal (`Done`/`WaitingApproval`/`Failed`) releases the run.
    Verifying,
    WaitingApproval,
    Done,
    Failed,
}

/// The kind of work a task represents (M4 §A). The shared contract between the
/// Rust core (which owns each kind's ORCHESTRATION policy in `kind.rs`) and the
/// engine (which owns its AGENT DEFINITION). `build` is the default and reproduces
/// pre-M4 behavior; `research`/`decompose` are reserved (defined, not yet
/// produced — the M1 `Ready`/`WaitingApproval` pattern).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    #[default]
    Build,
    Research,
    Review,
    Decompose,
}

impl TaskKind {
    /// The snake_case wire string the provider sends in `start-session` and the
    /// engine resolves to an agent preset.
    pub fn as_wire(&self) -> &'static str {
        match self {
            TaskKind::Build => "build",
            TaskKind::Research => "research",
            TaskKind::Review => "review",
            TaskKind::Decompose => "decompose",
        }
    }
}

/// Where a task's run executes (M4.6 §B). `Main` (the default) runs in the
/// project ROOT — edits land on the project's current branch directly, no
/// worktree, no auto-merge. `Worktree` allocates an isolated `nc/<taskId>` branch
/// and runs the full gate → commit → merge flow. A legacy task with no `run_mode`
/// loads as `Main` (serde default), so worktrees are opt-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    #[default]
    Main,
    Worktree,
}

impl RunMode {
    /// Whether this mode isolates the run in a `nc/<taskId>` worktree (vs. running
    /// in the project root on the current branch).
    pub fn is_worktree(&self) -> bool {
        matches!(self, RunMode::Worktree)
    }
}

/// One unit of orchestrated work. Field names mirror the M1 contract exactly and
/// serialize camelCase for the TS bridge and the on-disk JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    /// Other task ids this one depends on. Stored in M1, enforced in M2.
    pub dependencies: Vec<String>,
    /// `None` means "use the core/config default model".
    pub model: Option<String>,
    /// M4.7 §E: reasoning effort for this task's run (`low`/`medium`/`high`/
    /// `xhigh`/`max`). `None` ⇒ inherit the core/config default effort. Threaded
    /// into the `start-session` payload; the engine fixes it at session start.
    #[serde(default)]
    pub effort: Option<String>,
    /// M4.7 §A4: per-task permission-mode override (`bypass`/`auto-accept`/`ask`/
    /// `plan`). `None` ⇒ inherit the resolved default (project override → global).
    /// This is what lets a single task opt OUT of global bypass (e.g. `ask`/`plan`).
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// The worktree branch (`nc/<taskId>`) for this task's run, set by the M2
    /// coordinator once a worktree is allocated. `None` until then.
    pub branch: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    /// Sidecar session id of the last/current run, set once a run starts.
    pub session_id: Option<u64>,
    /// Result text on success.
    pub summary: Option<String>,
    /// Failure message on a failed run.
    pub error: Option<String>,
    /// Cost of the last run in USD.
    pub cost_usd: Option<f64>,
    /// The plan text captured when a `plan`-mode run calls `ExitPlanMode` and the
    /// task enters `waiting_approval`. Retained through `refine` so the user can
    /// edit and re-run; cleared on a fresh run. `None` until a plan is produced.
    #[serde(default)]
    pub plan: Option<String>,
    /// True once the task's worktree branch has a commit from `commit_task`. The
    /// board reflects this on the Verified card.
    #[serde(default)]
    pub committed: bool,
    /// True once `merge_task` integrated the branch into the project base. The card
    /// shows a disabled `Merged` state.
    #[serde(default)]
    pub merged: bool,
    /// True when `merge_task` hit a conflict it refused to force. The card surfaces
    /// the conflict so the user resolves it manually.
    #[serde(default)]
    pub conflict: bool,
    /// M4: the kind of work this task represents. Default `Build` (pre-M4
    /// behavior). Drives the orchestration policy (`kind.rs`) and the engine's
    /// agent preset.
    #[serde(default)]
    pub kind: TaskKind,
    /// M4.6: where this task's run executes — `main` (default, run in the project
    /// root on the current branch) or `worktree` (isolate on `nc/<taskId>`). Legacy
    /// tasks load as `main`. Settable at create + editable pre-run.
    #[serde(default)]
    pub run_mode: RunMode,
    /// M4: true only after an independent reviewer returned `VERDICT: PASS`.
    /// `merge_task` is gated on it. Cleared on a fresh run.
    #[serde(default)]
    pub verified: bool,
    /// M4: the reviewer's full verdict text (rationale + the `VERDICT:` line, or
    /// "auto-fix budget exhausted"). `None` until a review runs; cleared on a
    /// fresh run.
    #[serde(default)]
    pub review: Option<String>,
    /// M4: how many bounded auto-fix attempts the verification gate has spent on a
    /// `CHANGES_REQUESTED` verdict. Reset to 0 on a fresh run; capped at
    /// [`crate::sidecar::MAX_FIX_ATTEMPTS`].
    #[serde(default)]
    pub fix_attempts: u32,
}

impl Task {
    /// Build a fresh backlog task with a generated uuid and matching timestamps.
    pub fn new(title: String, description: String) -> Self {
        let now = now_ms();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            description,
            status: TaskStatus::Backlog,
            dependencies: Vec::new(),
            model: None,
            effort: None,
            permission_mode: None,
            branch: None,
            created_at: now,
            updated_at: now,
            session_id: None,
            summary: None,
            error: None,
            cost_usd: None,
            plan: None,
            committed: false,
            merged: false,
            conflict: false,
            kind: TaskKind::default(),
            run_mode: RunMode::default(),
            verified: false,
            review: None,
            fix_attempts: 0,
        }
    }

    /// Set the run mode (chainable; used by `create_task` to apply the project's
    /// default or an explicit override at creation).
    pub fn with_run_mode(mut self, run_mode: RunMode) -> Self {
        self.run_mode = run_mode;
        self
    }

    /// The prompt sent to the sidecar: title, then the description on a blank line
    /// when it is non-empty.
    pub fn prompt(&self) -> String {
        if self.description.is_empty() {
            self.title.clone()
        } else {
            format!("{}\n\n{}", self.title, self.description)
        }
    }
}

/// A partial update to a task — every field optional so the webview can patch
/// just what changed. Absent fields are left untouched.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<TaskStatus>,
    pub dependencies: Option<Vec<String>>,
    pub model: Option<String>,
    /// M4.7 §E: per-task reasoning effort, set from the create/edit picker.
    pub effort: Option<String>,
    /// M4.7 §A4: per-task permission-mode override, set from the create/edit picker.
    pub permission_mode: Option<String>,
    /// M4: the task kind, set from the create/edit picker.
    pub kind: Option<TaskKind>,
    /// M4.6: the run mode, editable pre-run from the create/edit picker.
    pub run_mode: Option<RunMode>,
}

impl TaskPatch {
    /// Apply the present fields of this patch onto `task`; absent fields are left
    /// untouched. `updated_at` is bumped by the store on persist, not here.
    pub fn apply(self, task: &mut Task) {
        if let Some(title) = self.title {
            task.title = title;
        }
        if let Some(description) = self.description {
            task.description = description;
        }
        if let Some(status) = self.status {
            task.status = status;
        }
        if let Some(dependencies) = self.dependencies {
            task.dependencies = dependencies;
        }
        if let Some(kind) = self.kind {
            task.kind = kind;
        }
        if let Some(run_mode) = self.run_mode {
            task.run_mode = run_mode;
        }
        // `model`/`effort`/`permission_mode` are themselves `Option`, so serde
        // flattens an absent field and an explicit `null` to the same `None`. A
        // patch can therefore SET each but not clear it; an absent/null value is
        // left untouched (same semantics as `model`).
        if self.model.is_some() {
            task.model = self.model;
        }
        if self.effort.is_some() {
            task.effort = self.effort;
        }
        if self.permission_mode.is_some() {
            task.permission_mode = self.permission_mode;
        }
    }
}

/// Current epoch time in milliseconds. Used for `created_at`/`updated_at`; we use
/// `SystemTime` rather than pulling in `chrono` for one timestamp.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

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
    run_mode: Option<RunMode>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
) -> Result<Task, String> {
    // Resolve every default once against the active project (per-project override →
    // global), mirroring how `default_run_mode` is applied — so the Settings
    // defaults are authoritative for a new task without the web having to seed them.
    let project_id = projects.active().map(|p| p.id);
    let pid = project_id.as_deref();
    let run_mode = run_mode.unwrap_or_else(|| settings.default_run_mode(pid));
    let mut task = Task::new(title, description).with_run_mode(run_mode);
    // P0: an explicit per-task model/effort wins; absent ⇒ stamp the resolved
    // Settings default (an SDK long id) so changing "Default model" in Settings
    // actually affects new runs. `permission_mode` stays lazily resolved at launch
    // (`resolve_permission_mode`), so `None` here means "inherit".
    task.model = Some(model.unwrap_or_else(|| settings.default_model(pid)));
    task.effort = Some(effort.unwrap_or_else(|| settings.default_effort(pid)));
    task.permission_mode = permission_mode;
    store.upsert(&task)?;
    let _ = app.emit(TASK_EVENT, &task);
    Ok(task)
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
    let _ = app.emit(TASK_EVENT, &task);
    Ok(task)
}

/// Delete a task and remove its JSON file. Also removes the task's transcript
/// directory (M4.7 §C) so a deleted task leaves no orphaned transcript. No-op
/// event; the webview drops the id on the command's success.
#[tauri::command]
pub fn delete_task(app: AppHandle, store: State<'_, TaskStore>, id: String) -> Result<(), String> {
    store.remove(&id)?;
    crate::transcript::remove_transcript(&app, &id);
    Ok(())
}

/// Parse a wire status string (snake_case, as the bridge sends it) into a
/// [`TaskStatus`], rejecting anything unknown. Reuses the enum's serde mapping so
/// the accepted strings can never drift from the wire contract.
fn parse_status(raw: &str) -> Result<TaskStatus, String> {
    serde_json::from_value(serde_json::Value::String(raw.to_string()))
        .map_err(|_| format!("unknown task status: {raw}"))
}

/// The ids of tasks that are launchable in status (`backlog`/`ready`) but whose
/// dependencies are not all `Done`. Read-only; the board surfaces these as the
/// "blocked" badge and disables their Run action. Fail-closed: a vanished or
/// failed dependency reads as blocked (mirrors [`crate::m2::deps::deps_satisfied`]).
#[tauri::command]
pub fn blocked_task_ids(store: State<'_, TaskStore>) -> Result<Vec<String>, String> {
    use crate::m2::deps::{index_by_id, is_blocked};
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
    let _ = app.emit(TASK_EVENT, &task);
    Ok(task)
}

/// The status validation + persistence behind [`move_task`], factored out so the
/// guards are unit-testable without a live `AppHandle`.
fn move_task_inner(store: &TaskStore, id: &str, status: &str) -> Result<Task, String> {
    let status = parse_status(status)?;
    if status == TaskStatus::InProgress {
        return Err("cannot move a task into In Progress — run it instead".to_string());
    }
    store.mutate(id, |task| task.status = status)
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
        for key in ["createdAt", "updatedAt", "sessionId", "costUsd", "branch"] {
            assert!(obj.contains_key(key), "missing camelCase key {key}");
        }
    }

    #[test]
    fn m3_fields_default_and_round_trip() {
        let task = Task::new("t".into(), String::new());
        assert!(task.plan.is_none(), "plan defaults to None");
        assert!(!task.committed && !task.merged && !task.conflict, "flags default false");

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
        assert_eq!(obj["kind"], serde_json::json!("build"), "kind serializes snake_case");

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
        assert_eq!(back.run_mode, RunMode::Main, "a task with no run_mode loads as Main");
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
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{}\"", kind.as_wire()));
            let back: TaskKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, back, "kind must survive a serde round-trip");
        }
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
        assert!(json.contains("\"branch\":\"nc/abc-123\""), "branch serializes camelCase");
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
        assert!(task.permission_mode.is_none(), "permission_mode defaults to None");

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
    fn patch_sets_model_when_present() {
        let mut task = Task::new("t".into(), String::new());
        assert!(task.model.is_none());
        let patch: TaskPatch =
            serde_json::from_str(r#"{"model":"claude-opus-4-8"}"#).unwrap();
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
    fn move_task_inner_rejects_unknown_status() {
        let (store, _tmp) = temp_store();
        let id = seed(&store, TaskStatus::Ready, &[]);

        let err = move_task_inner(&store, &id, "garbage").expect_err("must reject");
        assert!(err.contains("garbage"), "error names the bad status");
        assert_eq!(store.get(&id).expect("get").status, TaskStatus::Ready);
    }

    #[test]
    fn blocked_ids_includes_blocked_and_excludes_satisfied_and_running() {
        use crate::m2::deps::{index_by_id, is_blocked};
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

        assert!(ids.contains(&blocked), "a ready task with an unmet dep is blocked");
        assert!(!ids.contains(&satisfied), "a ready task with all deps done is not blocked");
        assert!(!ids.contains(&running), "an in-progress task is never blocked");
        assert!(!ids.contains(&done_dep), "a terminal task is never blocked");
    }
}
