//! The engine's command surface as seen by the sidecar bridge.
//!
//! The sidecar reader and command handlers need a handful of run-engine operations
//! (slot release/abort, the permission registry, the circuit breaker, the worktree
//! cleanup, the auto-loop kick + state emit, and the shared `submit_run`/`interrupt`
//! flows). Reaching for `crate::orchestration::coordinator::Orchestrator` directly
//! made `sidecar` depend on `orchestration`, closing a module cycle. This trait is
//! the seam that breaks it: it names exactly those operations against an opaque
//! `AppHandle`, with the concrete adapter (`orchestration::EngineHandle`) living on
//! the engine side. This module depends only on `tauri` + `async_trait` — never on
//! `crate::orchestration` — so the bridge can call the engine through a managed
//! `Arc<dyn EngineApi>` without importing it.

use tauri::AppHandle;

/// The run-engine operations the sidecar bridge invokes. Each method takes the
/// `AppHandle` and resolves the live engine from managed state inside the adapter,
/// so the bridge holds only `State<Arc<dyn EngineApi>>` and never names the
/// `Orchestrator`.
#[async_trait::async_trait]
pub trait EngineApi: Send + Sync {
    /// Abort a task's run driver (if attached) and release its slot. Preserved seam:
    /// `cancel_task` now KEEPS the slot leased until the run's terminal event releases
    /// it (so a cancel→re-run can't cross-wire a stale terminal onto the new run), so
    /// this is unused today — kept for a future provider whose run is a local driver
    /// task that cancel must abort (paired with `SlotManager::attach_abort`).
    #[allow(dead_code)]
    fn slots_abort(&self, app: &AppHandle, task_id: &str);
    /// Release a task's concurrency slot. Idempotent.
    fn slots_release(&self, app: &AppHandle, task_id: &str);
    /// Drop a single resolved permission request from a task's parked set. Returns
    /// whether it was actually parked.
    fn permissions_resolve(&self, app: &AppHandle, task_id: &str, request_id: &str) -> bool;
    /// Take and remove every permission request still parked for a task.
    fn permissions_drain_task(&self, app: &AppHandle, task_id: &str) -> Vec<String>;
    /// Record a parked permission request for a task.
    fn permissions_register(&self, app: &AppHandle, task_id: &str, request_id: &str);
    /// Clear the circuit-breaker failure window on a successful run.
    fn breaker_record_success(&self, app: &AppHandle);
    /// Record a failure; returns whether THIS failure tripped the breaker.
    fn breaker_record_failure(&self, app: &AppHandle) -> bool;
    /// The configured trip threshold (for diagnostics / the `nc:loop` payload).
    fn breaker_threshold(&self, app: &AppHandle) -> usize;
    /// Wake the coordinator to run a tick now.
    fn kick(&self, app: &AppHandle);
    /// Emit `nc:loop` with the current loop snapshot.
    fn emit_state(&self, app: &AppHandle, state: &str, reason: Option<&str>);
    /// Fail-closed: deny every permission request still parked for a task.
    async fn deny_parked_permissions(&self, app: &AppHandle, task_id: &str);
    /// Interrupt every in-flight run (the circuit-breaker pause path).
    async fn interrupt_all(&self, app: &AppHandle);
    /// The shared launch sequence behind the auto-loop and the manual `run_task`
    /// command. `feed_breaker` feeds the circuit breaker only for the auto-loop.
    async fn submit_run(&self, app: &AppHandle, task_id: &str, feed_breaker: bool)
        -> Result<(), String>;
}
