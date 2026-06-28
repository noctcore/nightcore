//! The `Task` data model: the wire enums, the `Task` struct + `TaskPatch`, and the
//! create-input plumbing.
//!
//! These are the central data types the studio orchestrates and the SHARED wire
//! contract with the webview. `Task` and its enums carry `ts-rs` derives, so the
//! Rust→TS codegen (`cargo test`) regenerates `apps/web/src/lib/generated/` from
//! them — every derive / `#[ts(...)]` / `#[serde(...)]` attribute and the field
//! order is load-bearing.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
// `ts-rs` is a DEV-dependency (the Rust→TS codegen runs only under `cargo test`),
// so its derive + attributes are gated behind `cfg(test)` via `cfg_attr`. The
// shipped binary never links it.
#[cfg(test)]
use ts_rs::TS;

use crate::gauntlet_project::StructureLockResult;

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

/// A sub-task a `decompose` run proposed (Decompose §B). Built from the structured
/// `proposedSubtasks` array the engine emits on the `session-completed` event (see
/// [`ProposedSubtask::from_wire`]) and stored on the parent [`Task`]; a convert
/// action mints a real board [`Task`] from it (`kind = Build`, `parent_task_id` =
/// the decompose task). Modeled on the Insight `StoredFinding` convert lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "ProposedSubtask.ts"))]
pub struct ProposedSubtask {
    /// Stable id (uuid), minted core-side when the proposal is built from the wire.
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

impl ProposedSubtask {
    /// Build a proposed sub-task from one wire `{title, prompt}` JSON object — an
    /// element of a `session-completed` event's `proposedSubtasks` array, which the
    /// engine emits only for `decompose`-kind sessions (Decompose §B). MINTS the
    /// core-owned fields here, never from the model's output: a fresh uuid `id`,
    /// `Open` status, and no `linked_task_id`. `title`/`prompt` come from the wire
    /// (`prompt` defaults to empty when absent). Returns `None` when the title is
    /// missing or blank, so a `filter_map` over the array drops those items.
    /// Mirrors the [`crate::store::insight::StoredFinding::from_wire`] convention.
    pub fn from_wire(v: &serde_json::Value) -> Option<Self> {
        let title = v.get("title").and_then(serde_json::Value::as_str)?;
        if title.trim().is_empty() {
            return None;
        }
        let prompt = v
            .get("prompt")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        Some(Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: title.to_string(),
            prompt,
            status: SubtaskStatus::Open,
            linked_task_id: None,
        })
    }
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
pub(super) struct CreateInputs {
    /// M4: the kind picked in the create dialog. `None` ⇒ the `Build` default
    /// (`TaskKind::default()`), preserving the pre-M4 create shape.
    pub(super) kind: Option<TaskKind>,
    pub(super) run_mode: Option<RunMode>,
    pub(super) model: Option<String>,
    pub(super) effort: Option<String>,
    pub(super) permission_mode: Option<String>,
    pub(super) max_turns: Option<u32>,
    pub(super) max_budget_usd: Option<f64>,
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
pub(super) fn build_new_task(
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
    // M4: stamp the picked kind (Build default when the create call omits it) so a
    // Decompose/Research/TDD selection in the dialog survives create — without this,
    // every new task fell back to `TaskKind::default()` regardless of the picker.
    task.kind = inputs.kind.unwrap_or_default();
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
