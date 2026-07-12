//! Run-lifecycle terminal bookkeeping (issue #37): how a finished/parked run
//! releases its slot, feeds (or spares) the circuit breaker, notifies the user,
//! and publishes task mutations to the board.
//!
//! Split out of `sidecar/mod.rs` so the terminal-transition policy is separate
//! from the NDJSON transport in [`super::transport`]. The historical
//! `crate::sidecar::*` paths are preserved by the facade re-export in
//! `sidecar/mod.rs`.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::engine_api::EngineApi;
use crate::provider::SidecarProvider;
use crate::store::TaskStore;
use crate::task::{Task, TASK_EVENT};

/// How a run ended, for terminal bookkeeping.
pub(crate) enum Outcome {
    /// `session-completed`: clean up the worktree (per policy), reset the breaker.
    Succeeded,
    /// `session-failed` (genuine): retain the worktree, feed the breaker. `fatal`
    /// carries the structured error taxonomy's verdict — an `auth`/`disk-full`
    /// category (a broken-setup cause) trips the breaker AT ONCE rather than
    /// accumulating toward the sliding-window threshold, so the auto-loop stops
    /// instead of burning more tasks that fail identically.
    Failed { fatal: bool },
    /// `session-failed { reason: "aborted" }` (cancel / circuit-break): retain the
    /// worktree, but do NOT count toward the breaker.
    ///
    /// The verification-gate "holding" terminal (FAIL / auto-fix budget exhausted /
    /// inconclusive) is NOT an `Outcome`: it routes through the standalone
    /// [`park_for_approval`], which releases the slot and retains the worktree
    /// without touching the breaker, so `finish_run` never sees it.
    Aborted,
}

/// A verification gate terminal (M4 §B "holding"): release the slot, forget the
/// session, RETAIN the worktree (the user will inspect/approve it), do NOT feed
/// the breaker, then kick the coordinator. Distinct from [`finish_run`], which
/// would clean the worktree and touch the breaker.
pub(crate) fn park_for_approval(app: &AppHandle, task_id: &str, session_id: Option<u64>) {
    let provider = app.state::<Arc<SidecarProvider>>();
    let engine = app.state::<Arc<dyn EngineApi>>();
    engine.slots_release(app, task_id);
    let _ = engine.permissions_drain_task(app, task_id);
    if let Some(sid) = session_id {
        provider.forget(sid);
    }
    // Worktree is intentionally retained; the breaker is intentionally untouched.
    engine.kick(app);
}

/// A run reached a terminal state: release its slot, drop the correlation binding,
/// clean up the worktree (per policy), feed the circuit breaker, and kick the
/// coordinator so the board drains without waiting a full interval.
/// Fire a desktop notification for a terminal task outcome, gated on the global
/// `notify_on_complete` setting (M3 §C). Only the two terminal outcomes the user
/// asked to be told about — `Done` and `Failed` — notify; aborts (user-cancelled)
/// and approval parks do not. The body carries only the task title + outcome —
/// never a token, secret, or summary (M4.5 logging discipline). Best-effort: a
/// failed notification is logged at debug, never surfaced.
pub(crate) fn notify_task_complete(app: &AppHandle, task_id: &str, succeeded: bool) {
    use crate::settings::SettingsStore;
    if !app
        .state::<SettingsStore>()
        .with_settings(|s| s.notify_on_complete)
    {
        return;
    }
    let Some(task) = app.state::<TaskStore>().get(task_id) else {
        return;
    };
    let outcome = if succeeded { "completed" } else { "failed" };
    let title = format!("Task {outcome}");
    let body = task.title;

    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::debug!(target: "nightcore", task_id, error = %e, "desktop notification failed");
    }
}

/// T11 (awaiting-input park): tell the user a run PARKED awaiting their input — an
/// `AskUserQuestion` the agent surfaced and cannot proceed past. Gated on
/// `notify_on_awaiting_input`, which defaults ON (unlike the Done/Failed
/// `notify_on_complete`): a backgrounded window otherwise silently stalls the
/// autonomous loop on a question no one sees. Body carries ONLY the task title —
/// never the question/option text (model-authored, surfaced to the UI but never
/// logged) or any secret (M4.5 logging discipline). Best-effort: a failed
/// notification is logged at debug, never surfaced. One notification per park (the
/// caller fires it once per `question-required` event).
pub(crate) fn notify_awaiting_input(app: &AppHandle, task_id: &str) {
    use crate::settings::SettingsStore;
    if !app
        .state::<SettingsStore>()
        .with_settings(|s| s.notify_on_awaiting_input)
    {
        return;
    }
    let Some(task) = app.state::<TaskStore>().get(task_id) else {
        return;
    };
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app
        .notification()
        .builder()
        .title("Waiting for your input")
        .body(task.title)
        .show()
    {
        tracing::debug!(target: "nightcore", task_id, error = %e, "awaiting-input notification failed");
    }
}

pub(crate) fn finish_run(
    app: &AppHandle,
    task_id: &str,
    session_id: Option<u64>,
    outcome: Outcome,
) {
    let provider = app.state::<Arc<SidecarProvider>>();
    let engine = app.state::<Arc<dyn EngineApi>>();
    engine.slots_release(app, task_id);
    // Any permission request still parked for this run is moot: the session has
    // reached a terminal state and the engine's own teardown denies its SDK control
    // request. Drop our registry entries so they can't leak across reruns.
    let _ = engine.permissions_drain_task(app, task_id);
    if let Some(sid) = session_id {
        provider.forget(sid);
    }
    // Worktree cleanup is deliberately NOT done here. A finished task — even a
    // verified/Done one — keeps its worktree so the user can still review, merge, or
    // discard it. The worktree is removed only when the user merges the branch
    // (`workflow::merge`, which honors `cleanupWorktrees` and also deletes the
    // `nc/<id>` branch) or explicitly discards it. Removing it on the terminal event
    // tore the worktree down before the user could merge — see the setting's own
    // copy ("after a task is merged") — leaving an orphaned branch.
    // M3 §C: tell the user a task reached a terminal state (Done/Failed only),
    // gated on `notify_on_complete`. Aborts/approval-parks don't notify.
    match outcome {
        Outcome::Succeeded => notify_task_complete(app, task_id, true),
        Outcome::Failed { .. } => notify_task_complete(app, task_id, false),
        Outcome::Aborted => {}
    }
    match outcome {
        Outcome::Succeeded => engine.breaker_record_success(app),
        Outcome::Aborted => {} // not a failure signal
        Outcome::Failed { fatal } => {
            // Category-based branch: a fatal-setup failure (auth/disk-full) trips the
            // breaker at once; a transient one accumulates toward the tolerant window.
            let tripped = if fatal {
                engine.breaker_record_fatal(app)
            } else {
                engine.breaker_record_failure(app)
            };
            if tripped {
                // This failure tripped the breaker: interrupt the rest and pause.
                let cause = if fatal {
                    "circuit-breaker-fatal"
                } else {
                    "circuit-breaker"
                };
                tracing::warn!(target: "nightcore", task_id, fatal, threshold = engine.breaker_threshold(app), "circuit breaker tripped; pausing auto-loop");
                engine.emit_state(app, "paused", Some(cause));
                let app = app.clone();
                // `tauri::async_runtime::spawn` (not bare `tokio::spawn`) — the latter
                // panics when no Tokio runtime is entered on the calling thread and
                // aborted the release app via SIGABRT across the WKWebView extern-"C"
                // boundary. `finish_run` is a `pub(crate)` terminal-transition helper;
                // a refactor reaching this breaker branch from a sync Tauri
                // command/callback thread would otherwise reintroduce the abort. Mirrors
                // the guarded sibling sites (fail_run in submit.rs, auto_loop start/stop)
                // and is guarded by the source-grep regression test below.
                tauri::async_runtime::spawn(async move {
                    app.state::<Arc<dyn EngineApi>>().interrupt_all(&app).await;
                });
            }
        }
    }
    engine.kick(app);
}

/// Mutate a task, persist, and emit `nc:task`.
pub(crate) fn apply_and_emit<F>(app: &AppHandle, store: &TaskStore, id: &str, f: F)
where
    F: FnOnce(&mut Task),
{
    match store.mutate(id, f) {
        Ok(task) => {
            // The store mutation already landed; if the emit fails the board never
            // learns the (often terminal Done/Failed) transition and the row stays
            // visually wedged until an unrelated later event repaints it. Rare, but
            // make the desync observable instead of swallowing it silently.
            if let Err(e) = app.emit(TASK_EVENT, &task) {
                tracing::warn!(target: "nightcore", task_id = id, error = %e, "failed to emit nc:task after mutation");
            }
        }
        Err(e) => {
            tracing::error!(target: "nightcore", task_id = id, error = %e, "failed to finalize task")
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn finish_run_breaker_trip_uses_the_guarded_spawn() {
        // Regression guard for the SIGABRT pattern (nightcore-2026-06-27-161645.ips):
        // the breaker-trip branch of `finish_run` must launch `interrupt_all` via
        // `tauri::async_runtime::spawn`, never bare `tokio::spawn` (which panics when no
        // Tokio runtime is entered on the calling thread and aborted the release app
        // across the WKWebView extern-"C" boundary). The spawn site needs a full
        // `AppHandle`, so this is a source-level guard rather than a behavioral one.
        // Unlike submit.rs, this file has legitimate on-runtime bare `tokio::spawn`s
        // (the sidecar stdout/stderr readers), so the guard is scoped to the window of
        // source immediately preceding the `interrupt_all` spawn body rather than a
        // blanket file-wide grep. Mirrors submit.rs's
        // `fail_run_breaker_trip_uses_the_guarded_spawn`.
        let src = include_str!("lifecycle.rs");
        let needle = ".interrupt_all(&app).await;";
        let at = src
            .find(needle)
            .expect("finish_run's interrupt_all spawn body must exist");
        // The `spawn(...)` opener sits on the line just above the interrupt_all call.
        let window = &src[at.saturating_sub(160)..at];
        let bare_spawn = concat!("tokio", "::spawn(async move {");
        assert!(
            !window.contains(bare_spawn),
            "finish_run must NOT use bare tokio::spawn — it aborts off-runtime (SIGABRT)"
        );
        assert!(
            window.contains("tauri::async_runtime::spawn(async move {"),
            "finish_run must launch interrupt_all via the guarded tauri::async_runtime::spawn"
        );
    }
}
