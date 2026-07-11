//! The engine-side adapter implementing [`crate::engine_api::EngineApi`].
//!
//! [`EngineHandle`] is a zero-sized handle managed as `Arc<dyn EngineApi>` in
//! `lib.rs`. Each method resolves the live [`Orchestrator`] (and the free
//! coordinator fns) from Tauri state and delegates, keeping the
//! `crate::orchestration::coordinator::Orchestrator` name on the engine side of the
//! seam so the sidecar bridge never imports `orchestration`.

use tauri::{AppHandle, Manager};

use crate::engine_api::EngineApi;

use super::coordinator::{self, Orchestrator};

/// Zero-sized adapter wired to the managed [`Orchestrator`]. Held as
/// `Arc<dyn EngineApi>` so the bridge depends on the trait, not the engine.
pub struct EngineHandle;

#[async_trait::async_trait]
impl EngineApi for EngineHandle {
    fn slots_abort(&self, app: &AppHandle, task_id: &str) {
        app.state::<Orchestrator>().slots.abort(task_id);
    }

    fn slots_release(&self, app: &AppHandle, task_id: &str) {
        app.state::<Orchestrator>().slots.release(task_id);
    }

    fn permissions_resolve(&self, app: &AppHandle, task_id: &str, request_id: &str) -> bool {
        app.state::<Orchestrator>()
            .permissions
            .resolve(task_id, request_id)
    }

    fn permissions_drain_task(&self, app: &AppHandle, task_id: &str) -> Vec<String> {
        app.state::<Orchestrator>().permissions.drain_task(task_id)
    }

    fn permissions_register(&self, app: &AppHandle, task_id: &str, request_id: &str) {
        app.state::<Orchestrator>()
            .permissions
            .register(task_id, request_id);
    }

    fn breaker_record_success(&self, app: &AppHandle) {
        app.state::<Orchestrator>().breaker.record_success();
    }

    fn breaker_record_failure(&self, app: &AppHandle) -> bool {
        app.state::<Orchestrator>().breaker.record_failure()
    }

    fn breaker_record_fatal(&self, app: &AppHandle) -> bool {
        app.state::<Orchestrator>().breaker.record_fatal_failure()
    }

    fn breaker_threshold(&self, app: &AppHandle) -> usize {
        app.state::<Orchestrator>().breaker.threshold()
    }

    fn kick(&self, app: &AppHandle) {
        app.state::<Orchestrator>().kick();
    }

    fn emit_state(&self, app: &AppHandle, state: &str, reason: Option<&str>) {
        // The trait stays string-typed so `sidecar` needn't name `orchestration`
        // (the decoupling invariant); re-type the reason at this boundary — the only
        // place a wire-string reason enters the coordinator.
        let reason = reason.and_then(coordinator::LoopReason::from_wire);
        app.state::<Orchestrator>().emit_state(app, state, reason);
    }

    async fn deny_parked_permissions(&self, app: &AppHandle, task_id: &str) {
        app.state::<Orchestrator>()
            .deny_parked_permissions(task_id)
            .await;
    }

    async fn interrupt_all(&self, app: &AppHandle) {
        app.state::<Orchestrator>().interrupt_all().await;
    }

    async fn submit_run(
        &self,
        app: &AppHandle,
        task_id: &str,
        feed_breaker: bool,
    ) -> Result<(), String> {
        coordinator::submit_run(app, task_id, feed_breaker).await
    }
}
