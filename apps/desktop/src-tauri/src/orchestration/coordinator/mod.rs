//! Auto-loop coordinator + orchestrator state (M2 §2 of the design doc).
//!
//! The [`Orchestrator`] is the single managed-state hub the M2 commands and the
//! sidecar reader share: it owns the [`SlotManager`], the [`CircuitBreaker`], the
//! [`SidecarProvider`], and the [`AutoLoop`] arming flag + kick signal. The
//! coordinator is the only stateful driver — the slot manager, breaker, dependency
//! resolver, and worktree manager are advisors/resources it consults.
//!
//! **Tick** (kicked + interval): while armed and not paused, pull eligible tasks
//! (launchable status, deps satisfied, free slot, not already leased), lease a
//! slot, allocate a worktree, mark `InProgress`, and dispatch the run via the
//! provider with `cwd = <worktree>`. On a terminal event the reader releases the
//! slot, cleans up the worktree (per `cleanupWorktrees`), feeds the breaker, and
//! kicks a re-tick so the board drains without waiting a full interval.

mod auto_loop;
mod cwd;
mod reconcile;
mod submit;

// Module facade: preserve the historical `crate::orchestration::coordinator::*`
// paths after the god-file split so external call sites keep resolving unchanged
// (lib.rs's `reconcile_*`/auto-loop command paths, sidecar's `submit_run`, settings'
// `set_max_concurrency`) and the cross-submodule calls inside this folder resolve
// via `super::*`. Glob re-exports mirror the `sidecar/mod.rs` facade.
pub(crate) use auto_loop::*;
pub(crate) use cwd::*;
pub(crate) use reconcile::*;
pub(crate) use submit::*;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`. The
// struct keeps its runtime `Serialize` derive (it IS the `nc:loop` payload).
#[cfg(test)]
use ts_rs::TS;

use crate::orchestration::breaker::CircuitBreaker;
use crate::provider::SidecarProvider;
use crate::orchestration::slots::SlotManager;
use crate::worktree;
use crate::project::ProjectStore;

/// The Tauri event reflecting auto-loop state. Payload:
/// `{ state, reason?, maxConcurrency, leased, failureThreshold }`.
pub const LOOP_EVENT: &str = "nc:loop";

/// The `nc:loop` payload (M2): the autonomous loop's snapshot. Typed so the web's
/// `LoopEnvelope` is generated from this struct (Rust→TS codegen) rather than
/// hand-mirrored — a field rename here can't silently drift the board. `state` is
/// the web-local `LoopState` union (`running`/`drained`/`paused`); `reason` is set
/// only on a pause and OMITTED otherwise (the board reads `loop.reason === undefined`
/// to detect the no-reason case), so it carries `skip_serializing_if` + `default`.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
// Exported to TS as `LoopEnvelope` (the board's name for the `nc:loop` payload) so
// the generated binding drops in for the prior hand-mirror unchanged.
#[cfg_attr(
    test,
    ts(export, rename = "LoopEnvelope", export_to = "LoopEnvelope.ts")
)]
pub struct LoopSnapshot {
    /// The loop run state (`running` | `drained` | `paused`).
    pub state: String,
    /// Set only when `state == "paused"` (e.g. the circuit-breaker reason);
    /// omitted otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub reason: Option<String>,
    /// The live concurrency cap (the slot pool's `max`).
    pub max_concurrency: u64,
    /// How many slots are currently leased to running agents.
    pub leased: u64,
    /// The consecutive-failure count that trips the circuit breaker.
    pub failure_threshold: u64,
}

/// The auto-loop arming flag + the tick task handle.
#[derive(Default)]
pub struct AutoLoop {
    running: AtomicBool,
    /// Generation counter: bumping it signals the current tick task to exit, so a
    /// stop/start can't leave two tick loops racing.
    generation: AtomicUsize,
}

impl AutoLoop {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

/// Parked interactive permission requests, keyed by task id. A `permission-required`
/// event registers its `requestId` here; `respond_permission` resolves and removes
/// it; a task's cancel/abort/circuit-break fail-closed-denies and drains every
/// request still parked for that task so a session can never hang.
#[derive(Default)]
pub struct PendingPermissions {
    by_task: Mutex<HashMap<String, Vec<String>>>,
}

impl PendingPermissions {
    /// Record a parked request for a task.
    pub fn register(&self, task_id: &str, request_id: &str) {
        crate::sync::lock_or_recover(&self.by_task)
            .entry(task_id.to_string())
            .or_default()
            .push(request_id.to_string());
    }

    /// Drop a single resolved request from a task's parked set. Returns true when it
    /// was actually parked (so a stale/duplicate decision is a no-op).
    pub fn resolve(&self, task_id: &str, request_id: &str) -> bool {
        let mut guard = crate::sync::lock_or_recover(&self.by_task);
        let Some(reqs) = guard.get_mut(task_id) else {
            return false;
        };
        let Some(idx) = reqs.iter().position(|r| r == request_id) else {
            return false;
        };
        reqs.remove(idx);
        if reqs.is_empty() {
            guard.remove(task_id);
        }
        true
    }

    /// Take and remove every request still parked for a task (its terminal/abort
    /// drain). Returns the request ids to fail-closed-deny.
    pub fn drain_task(&self, task_id: &str) -> Vec<String> {
        crate::sync::lock_or_recover(&self.by_task)
            .remove(task_id)
            .unwrap_or_default()
    }
}

/// The shared M2 hub held in managed Tauri state.
pub struct Orchestrator {
    pub slots: SlotManager,
    pub breaker: CircuitBreaker,
    /// Shared so the sidecar bridge can hold the same provider as managed state
    /// (`Arc<SidecarProvider>`) without reaching through the `Orchestrator`.
    pub provider: Arc<SidecarProvider>,
    pub auto: AutoLoop,
    /// Parked interactive permission requests awaiting a surface decision (M3).
    pub permissions: PendingPermissions,
    /// Kicked to run a tick immediately (on launch, on terminal events).
    kick: Notify,
}

impl Orchestrator {
    /// Build the hub. The provider is configured to spawn `bun run <entry>` in the
    /// workspace root, matching M1.
    pub fn new(entry: PathBuf, cwd: PathBuf, max_concurrency: usize) -> Self {
        Self {
            slots: SlotManager::new(max_concurrency),
            breaker: CircuitBreaker::default(),
            provider: Arc::new(SidecarProvider::new(entry, cwd)),
            auto: AutoLoop::default(),
            permissions: PendingPermissions::default(),
            kick: Notify::new(),
        }
    }

    /// Wake the coordinator to run a tick now.
    pub fn kick(&self) {
        self.kick.notify_one();
    }

    /// Interrupt every in-flight run (the effective cancellation — a run lives in
    /// the sidecar process, so `interrupt` is what actually stops it). The runs
    /// then emit `session-failed (aborted)`, which releases their slots via the
    /// reader. Also aborts any attached driver task as bookkeeping.
    pub async fn interrupt_all(&self) {
        use crate::provider::Provider;
        for sid in self.provider.live_sessions() {
            // Fail-closed: deny any parked permission request for this run before
            // interrupting, so a session waiting on approval doesn't hang.
            if let Some(task_id) = self.provider.task_for(sid) {
                self.deny_parked_permissions(&task_id).await;
            }
            if let Err(e) = self.provider.interrupt(sid).await {
                // Best-effort: the session may already be tearing down. Log so a
                // wedged interrupt is visible rather than silently swallowed (#8).
                tracing::warn!(target: "nightcore", session_id = sid, error = %e, "interrupt of in-flight session failed");
            }
        }
        self.slots.abort_all();
    }

    /// Fail-closed: deny every permission request still parked for `task_id` and
    /// clear them. Called when a task is cancelled, aborted, or circuit-broken so a
    /// session waiting on a surface decision can never hang. Resolving the session
    /// id is best-effort — once the run is torn down the binding may already be
    /// gone, in which case the engine's own teardown (`failAllPending`) denies it.
    pub async fn deny_parked_permissions(&self, task_id: &str) {
        use crate::provider::{PermissionDecision, Provider};
        let request_ids = self.permissions.drain_task(task_id);
        if request_ids.is_empty() {
            return;
        }
        let Some(session_id) = self.provider.session_for(task_id) else {
            return;
        };
        for request_id in request_ids {
            let _ = self
                .provider
                .decide_permission(
                    session_id,
                    &request_id,
                    PermissionDecision::Deny {
                        message: "Nightcore: task cancelled before approval.".to_string(),
                    },
                )
                .await;
        }
    }

    /// Emit `nc:loop` with the current loop snapshot. Serializes the typed
    /// [`LoopSnapshot`] (the source of the web's generated `LoopEnvelope`) so the
    /// payload keys can't drift from the contract.
    pub fn emit_state(&self, app: &AppHandle, state: &str, reason: Option<&str>) {
        let _ = app.emit(
            LOOP_EVENT,
            LoopSnapshot {
                state: state.to_string(),
                reason: reason.map(str::to_string),
                max_concurrency: self.slots.max() as u64,
                leased: self.slots.leased_count() as u64,
                failure_threshold: self.breaker.threshold() as u64,
            },
        );
    }
}

// --- Commands ---------------------------------------------------------------

/// Arm the coordinator: start pulling eligible tasks off the board and running
/// them up to the concurrency cap, in isolated worktrees, respecting deps.
#[tauri::command]
pub fn start_auto_loop(app: AppHandle) -> Result<(), String> {
    start(&app)
}

/// Disarm the coordinator and abort every in-flight run.
#[tauri::command]
pub fn stop_auto_loop(app: AppHandle) -> Result<(), String> {
    stop(&app);
    Ok(())
}

/// Clear a circuit-breaker pause and resume the loop.
#[tauri::command]
pub fn resume_auto_loop(app: AppHandle) -> Result<(), String> {
    resume(&app)
}

/// Resize the parallel-run pool (1..=N). Persisted concurrency lives in settings;
/// this applies it to the live pool.
#[tauri::command]
pub fn set_max_concurrency_cmd(app: AppHandle, n: usize) -> Result<(), String> {
    set_max_concurrency(&app, n);
    Ok(())
}

/// List the live Nightcore worktrees for the active project (M4.6 §C): each
/// `nc/<taskId>` worktree on disk with its `{ branch, path, taskIds, dirty,
/// aheadOfBase }`, driving the web switcher's monitor indicators. Read-only and
/// cheap; tolerant of a missing/locked worktree (it degrades to safe defaults).
/// Returns an empty list when there is no active project.
#[tauri::command]
pub fn list_worktrees(app: AppHandle) -> Result<Vec<worktree::WorktreeStatus>, String> {
    let Some(project) = app.state::<ProjectStore>().active() else {
        return Ok(Vec::new());
    };
    Ok(worktree::list_worktree_statuses(&PathBuf::from(
        &project.path,
    )))
}

/// Silence the unused-import lint for `Arc`/`Notify` when only `Notify` is used
/// directly; `Arc` is kept available for a future shared-handle path.
#[allow(dead_code)]
type SharedNotify = Arc<Notify>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_permissions_register_resolve_and_drain() {
        let pending = PendingPermissions::default();
        pending.register("task-1", "req-a");
        pending.register("task-1", "req-b");
        pending.register("task-2", "req-c");

        // Resolving a parked request returns true and removes only it.
        assert!(pending.resolve("task-1", "req-a"));
        // A stale/duplicate resolve is a no-op.
        assert!(!pending.resolve("task-1", "req-a"));
        assert!(!pending.resolve("task-9", "ghost"));

        // Draining a task takes everything still parked for it (fail-closed deny set).
        let drained = pending.drain_task("task-1");
        assert_eq!(drained, vec!["req-b".to_string()]);
        // Draining again is empty; the entry is gone.
        assert!(pending.drain_task("task-1").is_empty());
        // Other tasks are untouched.
        assert_eq!(pending.drain_task("task-2"), vec!["req-c".to_string()]);
    }

    #[test]
    fn auto_loop_starts_disarmed() {
        let auto = AutoLoop::default();
        assert!(!auto.is_running(), "loop is off until started");
    }
}
