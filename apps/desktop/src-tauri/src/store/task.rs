//! The task model and the CRUD commands over the task registry.
//!
//! A `Task` is the unit of work the studio orchestrates: a prompt with a
//! lifecycle. M1 owns creating, editing, deleting, listing, and persisting
//! tasks; running one through the sidecar lives in `sidecar.rs`. Every mutation
//! goes through the [`TaskStore`](crate::store::TaskStore) (persist) and emits
//! `nc:task` (the full task) so the webview can upsert its board by id.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
// `ts-rs` is a DEV-dependency (the Rust→TS codegen runs only under `cargo test`),
// so its derive + attributes are gated behind `cfg(test)` via `cfg_attr`. The
// shipped binary never links it.
#[cfg(test)]
use ts_rs::TS;

use tauri::{AppHandle, Emitter, State};

use crate::gauntlet_project::StructureLockResult;
use crate::store::TaskStore;

/// The Tauri event carrying a single task to the webview. The UI upserts its
/// board state by `task.id`, so every create/update/status change re-emits this.
pub const TASK_EVENT: &str = "nc:task";

/// Where a task sits in its lifecycle. `ready` and `waiting_approval` are
/// reserved in M1 (defined, not yet produced): the auto-loop and interactive
/// approval that drive them arrive in M2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, ts(export, export_to = "TaskStatus.ts"))]
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
/// pre-M4 behavior; `tdd` is a build-like test-first variant; `decompose` proposes
/// sub-tasks; `research` investigates read-only; `review` is the internal
/// verification reviewer's identity (not user-selectable in the picker).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, ts(export, export_to = "TaskKind.ts"))]
pub enum TaskKind {
    #[default]
    Build,
    Research,
    Review,
    Decompose,
    /// Test-first build: the agent writes a failing test, then implements until
    /// green. Orchestrated identically to `Build` (own worktree + verification);
    /// only the engine's AGENT DEFINITION (the test-first persona) differs.
    Tdd,
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
            TaskKind::Tdd => "tdd",
        }
    }
}

/// Lifecycle of one [`ProposedSubtask`] (Decompose §B). `open` until the user
/// converts it into a board task, then `converted` (with `linked_task_id` set).
/// Mirrors the Insight finding lifecycle so the convert UX is identical.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, ts(export, export_to = "SubtaskStatus.ts"))]
pub enum SubtaskStatus {
    #[default]
    Open,
    Converted,
}

/// A sub-task a `decompose` run proposed (Decompose §B). Parsed from the agent's
/// final message and stored on the parent [`Task`]; a convert action mints a real
/// board [`Task`] from it (`kind = Build`, `parent_task_id` = the decompose task).
/// Modeled on the Insight `StoredFinding` convert lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ProposedSubtask.ts"))]
pub struct ProposedSubtask {
    /// Stable id (uuid), assigned when the run's proposal is parsed.
    pub id: String,
    /// Short imperative title — becomes the child task's title.
    pub title: String,
    /// Self-contained description — becomes the child task's description/prompt.
    pub prompt: String,
    /// `open` until converted; `converted` once a board task was minted from it.
    #[serde(default)]
    pub status: SubtaskStatus,
    /// The board task this proposal was converted into, if any.
    #[serde(default)]
    pub linked_task_id: Option<String>,
}

/// Where a task's run executes (M4.6 §B). `Main` (the default) runs in the
/// project ROOT — edits land on the project's current branch directly, no
/// worktree, no auto-merge. `Worktree` allocates an isolated `nc/<taskId>` branch
/// and runs the full gate → commit → merge flow. A legacy task with no `run_mode`
/// loads as `Main` (serde default), so worktrees are opt-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(test, ts(export, export_to = "RunMode.ts"))]
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

/// The four UI permission modes (M4.7 §A1) the surface offers per task and as the
/// resolved project/global default. This is the STUDIO vocabulary — distinct from
/// the engine's SDK `permissionMode` (`@nightcore/contracts` `PermissionMode`),
/// which these map to via [`crate::settings::sdk_permission_mode`]. It exists
/// purely to narrow the generated TS for the `permission_mode` fields (the Rust
/// store keeps them as free `Option<String>` so a legacy/unknown value still
/// loads); the wire strings are these kebab/word forms verbatim.
///
/// This type exists ONLY to drive the Rust→TS codegen (the `#[ts(as = "…")]`
/// narrowing on the `permission_mode` fields), so it is `cfg(test)`-only — the
/// shipped binary never constructs it (the store reads/writes the free string).
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "PermissionMode.ts")]
pub enum PermissionMode {
    #[serde(rename = "bypass")]
    Bypass,
    #[serde(rename = "auto-accept")]
    AutoAccept,
    #[serde(rename = "ask")]
    Ask,
    #[serde(rename = "plan")]
    Plan,
}

/// One image attached to a task, persisted to OS app-data (see
/// [`crate::store::attachments`]). The on-disk file is
/// `<app-data>/attachments/<taskId>/<id>.<format>`; this ref stores the
/// server-minted `id`, the original `filename` (a display label only — never used
/// to build a path), the image `format` token (`png`/`jpeg`/`webp`/`gif`, stored as
/// a free string per the codebase convention), and the byte `size`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "TaskAttachment.ts"))]
pub struct TaskAttachment {
    pub id: String,
    pub filename: String,
    pub format: String,
    pub size: u64,
}

/// One unit of orchestrated work. Field names mirror the M1 contract exactly and
/// serialize camelCase for the TS bridge and the on-disk JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "Task.ts"))]
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
    // Stored as a free string (a legacy/unknown value still loads), but the wire
    // values are exactly the [`PermissionMode`] vocabulary — narrow the generated
    // TS to `PermissionMode | null` so the board's picker + label map type-check.
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<PermissionMode>"))]
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
    /// Feature #3 (Structure-Lock Gauntlet): the result of the TARGET project's own
    /// generated harness checks (custom lint-plugin / dependency-cruiser / coverage
    /// thresholds), run as a deterministic gate before the paid reviewer and again
    /// at merge. `None` until the gate runs — and it stays `None` when the project
    /// has no `.nightcore/harness.json` (every check is opt-in). Serde-additive: a
    /// legacy task without it loads as `None`, so existing task files aren't broken.
    #[serde(default)]
    pub structure_lock_result: Option<StructureLockResult>,
    // --- SDK guardrails (autonomy ceilings + resume) ------------------------
    /// SDK-guardrails: per-task max conversation turns before the run stops
    /// (engine `Options.maxTurns`). `None` ⇒ inherit the `@nightcore/config`
    /// default. Threaded into the `start-session` payload as `maxTurns`.
    #[serde(default)]
    pub max_turns: Option<u32>,
    /// SDK-guardrails: per-task hard cost ceiling in USD (engine
    /// `Options.maxBudgetUsd`). `None` ⇒ inherit the config default (uncapped
    /// unless configured). Threaded into the payload as `maxBudgetUsd`.
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
    /// SDK-guardrails: the SDK session UUID of the last run, captured from the
    /// engine's `session-ready` event. Distinct from `session_id` (the numeric
    /// Nightcore id). On a relaunch (manual re-run or boot reconcile) it is
    /// threaded back as `resumeSessionId` so a crashed/HMR-killed run reattaches
    /// instead of restarting cold. `None` until the first run reports it.
    /// Bookkeeping, not a secret — never logged at info/telemetry.
    #[serde(default)]
    pub sdk_session_id: Option<String>,
    /// A strictly-monotonic per-store sequence stamped on every persist+emit, so a
    /// consumer can order `nc:task` snapshots without relying on millisecond
    /// `updated_at` (which collides under rapid status changes). Assigned by the
    /// store from a single atomic counter; each emitted snapshot for a store carries
    /// a greater `seq` than the prior one. Additive: legacy task JSON with no `seq`
    /// loads as `0`, and the next persist re-stamps it.
    #[serde(default)]
    pub seq: u64,
    /// Image attachments for this task's run, persisted to OS app-data (NOT the repo
    /// or a worktree) and loaded as SDK image content blocks at launch. Set at create
    /// and editable pre-run. Serde-additive: a legacy task without it loads as an
    /// empty list.
    #[serde(default)]
    pub attachments: Vec<TaskAttachment>,
    /// Decompose §B: the parent `decompose` task this one was minted from, if any.
    /// Set only on children created via `convert_subtask`/`convert_all_subtasks`;
    /// `None` for every other task. Serde-additive: legacy tasks load as `None`.
    #[serde(default)]
    pub parent_task_id: Option<String>,
    /// Decompose §B: the sub-tasks a `decompose` run proposed (parsed from its final
    /// message on completion). Empty for every other kind and until a decompose run
    /// finishes. Each is convertible into a board task. Serde-additive: legacy tasks
    /// load as an empty list.
    #[serde(default)]
    pub proposed_subtasks: Vec<ProposedSubtask>,
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
            structure_lock_result: None,
            max_turns: None,
            max_budget_usd: None,
            sdk_session_id: None,
            // Stamped by the store on the first persist; 0 until then.
            seq: 0,
            attachments: Vec::new(),
            parent_task_id: None,
            proposed_subtasks: Vec::new(),
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
// The web CONSTRUCTS this patch and only ever sends the keys it changed, so every
// field is an OPTIONAL key in TS (`field?`), not a required `field: T | null`.
// `#[ts(optional)]` ⇒ `field?: T`; `#[ts(optional = nullable)]` ⇒ `field?: T | null`
// (matching the prior hand-mirror exactly, including the `model`/`effort` etc.
// fields the bridge declared as nullable-optional). ts-rs derives `TS` without a
// `Serialize` impl, so deserialize-only patch types still export.
#[derive(Debug, Default, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "TaskPatch.ts"))]
pub struct TaskPatch {
    #[cfg_attr(test, ts(optional))]
    pub title: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub description: Option<String>,
    #[cfg_attr(test, ts(optional))]
    pub status: Option<TaskStatus>,
    #[cfg_attr(test, ts(optional))]
    pub dependencies: Option<Vec<String>>,
    #[cfg_attr(test, ts(optional = nullable))]
    pub model: Option<String>,
    /// M4.7 §E: per-task reasoning effort, set from the create/edit picker.
    #[cfg_attr(test, ts(optional = nullable))]
    pub effort: Option<String>,
    /// M4.7 §A4: per-task permission-mode override, set from the create/edit picker.
    #[cfg_attr(test, ts(optional = nullable, as = "Option<PermissionMode>"))]
    pub permission_mode: Option<String>,
    /// M4: the task kind, set from the create/edit picker.
    #[cfg_attr(test, ts(optional))]
    pub kind: Option<TaskKind>,
    /// M4.6: the run mode, editable pre-run from the create/edit picker.
    #[cfg_attr(test, ts(optional))]
    pub run_mode: Option<RunMode>,
    /// SDK-guardrails: per-task max-turns override, editable pre-run.
    #[cfg_attr(test, ts(optional = nullable))]
    pub max_turns: Option<u32>,
    /// SDK-guardrails: per-task max-budget-USD override, editable pre-run.
    #[cfg_attr(test, ts(optional = nullable))]
    pub max_budget_usd: Option<f64>,
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
        // Autonomy ceilings follow the same `Option`-set-not-clear semantics as
        // `model`/`effort`: a present value sets the override; absent/null leaves
        // it untouched (inherit the config default at launch).
        if self.max_turns.is_some() {
            task.max_turns = self.max_turns;
        }
        if self.max_budget_usd.is_some() {
            task.max_budget_usd = self.max_budget_usd;
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

/// The optional create-time overrides for a new task. Each `None` field falls
/// back to the resolved Settings default (per-project override → global → the
/// engine's `@nightcore/config` default).
#[derive(Debug, Default)]
struct CreateInputs {
    run_mode: Option<RunMode>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
}

/// Build a fresh backlog task, stamping the resolved Settings defaults for any
/// field the create call left unset. Factored out of [`create_task`] so the
/// default-resolution is unit-testable without an `AppHandle`.
///
/// Resolution order per field: explicit create input → Settings (per-project
/// override → global). `model`/`effort`/`run_mode` always end up concrete (Settings
/// has a non-optional default for them). The guardrail ceilings stay `None` when
/// Settings has no value either, so the engine's `@nightcore/config` default
/// (maxTurns 200, budget uncapped) applies at launch.
fn build_new_task(
    settings: &crate::settings::SettingsStore,
    pid: Option<&str>,
    title: String,
    description: String,
    inputs: CreateInputs,
) -> Task {
    let run_mode = inputs
        .run_mode
        .unwrap_or_else(|| settings.default_run_mode(pid));
    let mut task = Task::new(title, description).with_run_mode(run_mode);
    // P0: an explicit per-task model/effort wins; absent ⇒ stamp the resolved
    // Settings default (an SDK long id) so changing "Default model" in Settings
    // actually affects new runs. `permission_mode` stays lazily resolved at launch
    // (`resolve_permission_mode`), so `None` here means "inherit".
    task.model = Some(inputs.model.unwrap_or_else(|| settings.default_model(pid)));
    task.effort = Some(
        inputs
            .effort
            .unwrap_or_else(|| settings.default_effort(pid)),
    );
    task.permission_mode = inputs.permission_mode;
    // SDK-guardrails: an explicit per-task ceiling wins; absent ⇒ stamp the
    // resolved Settings default (per-project override → global), so the Settings
    // "Limits" knob is authoritative for a new task. When Settings has no ceiling
    // either, this stays `None` and the engine's `@nightcore/config` default
    // applies at launch — same resolution shape as `model`/`effort`/`run_mode`.
    task.max_turns = inputs.max_turns.or_else(|| settings.default_max_turns(pid));
    task.max_budget_usd = inputs
        .max_budget_usd
        .or_else(|| settings.default_max_budget_usd(pid));
    task
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

/// Mint one child task from a proposed sub-task and atomically mark the proposal
/// converted. Shared by [`convert_subtask`] and [`convert_all_subtasks`].
fn convert_one(
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
        sub.title.clone(),
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
    if let Err(e) = crate::m2::worktree::remove(&project_path, id) {
        tracing::warn!(target: "nightcore", task_id = id, error = %e, "delete: worktree remove failed");
    }
    if let Err(e) = crate::m2::worktree::delete_branch(&project_path, id) {
        tracing::warn!(target: "nightcore", task_id = id, error = %e, "delete: branch delete failed");
    }
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
    tracing::info!(target: "nightcore", task_id = %id, status = %status, "task moved");
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
