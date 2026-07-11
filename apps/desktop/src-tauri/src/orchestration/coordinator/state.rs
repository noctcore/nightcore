//! The coordinator's shared managed state: the [`Orchestrator`] hub, its
//! [`AutoLoop`] arming flag, the [`PendingPermissions`] park, and the typed
//! [`LoopSnapshot`] `nc:loop` payload. The `#[tauri::command]` handlers live in
//! the `commands` sibling; the lifecycle/tick driver in `auto_loop`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`. The
// struct keeps its runtime `Serialize` derive (it IS the `nc:loop` payload).
#[cfg(test)]
use ts_rs::TS;

use crate::orchestration::breaker::CircuitBreaker;
use crate::orchestration::slots::SlotManager;
use crate::provider::SidecarProvider;

use super::usage_gate::{notify_usage_pause, UsagePause, UsagePauseLatch};

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
    pub(super) running: AtomicBool,
    /// Generation counter: bumping it signals the current tick task to exit, so a
    /// stop/start can't leave two tick loops racing.
    pub(super) generation: AtomicUsize,
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
    /// Usage-aware auto-mode throttle (spec 2026-07-11): the one-shot latch so the
    /// board banner-signal + OS notification fire once per usage-pause episode, not
    /// every 750ms tick. The gate DECISION itself is stateless (non-latching) —
    /// re-checked live each tick from the meter — so this latch only debounces the
    /// transition side effects, it never gates the loop.
    pub usage_pause: UsagePauseLatch,
    /// Kicked to run a tick immediately (on launch, on terminal events).
    pub(super) kick: Notify,
}

impl Orchestrator {
    /// Build the hub. The provider is chosen by the `provider` setting through the
    /// ONE [`build_provider`](crate::provider::build_provider) factory (issue #18) and
    /// configured to spawn `bun run <entry>` in the workspace root, matching M1. An
    /// unknown id logs a loud warning and falls back to the default Claude provider
    /// through the SAME factory (never a silent wrong backend, never a bricked
    /// launch on a typo'd setting).
    pub fn new(entry: PathBuf, cwd: PathBuf, max_concurrency: usize, provider_id: &str) -> Self {
        let provider = crate::provider::build_provider(provider_id, entry.clone(), cwd.clone())
            .unwrap_or_else(|e| {
                tracing::warn!(
                    target: "nightcore",
                    provider = %provider_id,
                    error = %e,
                    "unknown provider setting; falling back to the default Claude provider"
                );
                crate::provider::build_provider(crate::provider::CLAUDE_PROVIDER_ID, entry, cwd)
                    .expect("the default Claude provider always builds")
            });
        Self {
            slots: SlotManager::new(max_concurrency),
            breaker: CircuitBreaker::default(),
            provider,
            auto: AutoLoop::default(),
            permissions: PendingPermissions::default(),
            usage_pause: UsagePauseLatch::default(),
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

    /// Enter the usage-pause (spec 2026-07-11): reflect `paused`/`usage` on `nc:loop`
    /// so the board banner shows, and — ONCE per episode (the false→true edge) — fire
    /// the single OS notification (decision 3). Idempotent across the 750ms ticks
    /// that keep the pause hot: only the transition tick notifies. It does NOT stop
    /// or interrupt anything — the tick simply returns without launching new runs.
    pub fn enter_usage_pause(&self, app: &AppHandle, pause: &UsagePause) {
        let first = self.usage_pause.enter();
        // The reason rides the existing free-string `nc:loop` `reason` (matched
        // web-side with `includes('usage')`) — no schema change, no new channel.
        self.emit_state(app, "paused", Some("usage"));
        if first {
            notify_usage_pause(app, pause);
            tracing::info!(
                target: "nightcore",
                provider = %pause.provider,
                window = %pause.window_label,
                pct = pause.used_percent,
                resets_at = ?pause.resets_at,
                "auto-loop usage-paused (meter hot); running sessions finish untouched"
            );
        }
    }

    /// Leave the usage-pause when the window cools: on the true→false edge, re-emit
    /// `running` so the banner clears promptly (the tick then launches as normal).
    /// A no-op when we weren't usage-paused. The latch resets, so a later re-heat is
    /// a fresh episode that notifies again.
    pub fn leave_usage_pause(&self, app: &AppHandle) {
        if self.usage_pause.leave() {
            self.emit_state(app, "running", None);
            tracing::info!(target: "nightcore", "auto-loop usage-pause cleared; resuming pickups");
        }
    }
}

/// Silence the unused-import lint for `Arc`/`Notify` when only `Notify` is used
/// directly; `Arc` is kept available for a future shared-handle path.
#[allow(dead_code)]
type SharedNotify = Arc<Notify>;
