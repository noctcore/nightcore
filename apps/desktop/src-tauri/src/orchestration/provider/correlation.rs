//! Session/task correlation bookkeeping for [`SidecarProvider`]: the live
//! `sessionId -> taskId` map, the pending-launch FIFO, run timers, and the
//! post-crash reset.

use super::*;

impl SidecarProvider {
    /// Record that `task_id` is launching a run. Called under the stdin lock right
    /// before the `start-session` write so the FIFO order matches the wire order.
    pub(super) fn push_pending(&self, task_id: &str) {
        crate::sync::lock_or_recover(&self.correlation)
            .pending
            .push_back(task_id.to_string());
    }

    /// Bind a freshly-seen `session_id` to the task at the front of the pending
    /// FIFO. Called by the reader the first time it sees a session id. Returns the
    /// task id it bound, if any pending launch was waiting.
    pub fn correlate(&self, session_id: u64) -> Option<String> {
        let mut c = crate::sync::lock_or_recover(&self.correlation);
        if let Some(existing) = c.by_session.get(&session_id) {
            return Some(existing.clone());
        }
        let Some(task_id) = c.pending.pop_front() else {
            // A session id with no pending launch to bind — the FIFO desynced (a
            // launch was evicted, or the engine emitted an unexpected session).
            // Logged so a correlation desync is visible rather than a silent drop.
            tracing::warn!(target: "nightcore", session_id, "correlation desync: session id with no pending launch");
            return None;
        };
        tracing::info!(target: "nightcore", task_id = %task_id, session_id, "bound session to task");
        c.by_session.insert(session_id, task_id.clone());
        c.started_at
            .entry(session_id)
            .or_insert_with(std::time::Instant::now);
        Some(task_id)
    }

    /// The wall-clock duration since a session first correlated, in milliseconds, if
    /// it is still tracked. Read on a terminal event to log the run's `duration_ms`
    /// (observability #5). `None` once the session has been forgotten.
    pub fn run_duration_ms(&self, session_id: u64) -> Option<u64> {
        crate::sync::lock_or_recover(&self.correlation)
            .started_at
            .get(&session_id)
            .map(|t| t.elapsed().as_millis() as u64)
    }

    /// Evict the most-recently-pushed pending launch for `task_id` if it has not yet
    /// correlated to a session id (concurrency #5). Called when a launch is torn
    /// down (cancel/abort/circuit-break) before its `session-started` arrived, so a
    /// later, unrelated `session-started` can't mis-bind to this dead launch and
    /// poison the FIFO. A no-op once the launch has correlated (then `forget`
    /// drops the binding instead). Returns whether an entry was removed.
    pub fn evict_pending(&self, task_id: &str) -> bool {
        let mut c = crate::sync::lock_or_recover(&self.correlation);
        // Already correlated ⇒ nothing pending to evict (forget handles the binding).
        if c.by_session.values().any(|t| t == task_id) {
            return false;
        }
        // Remove the last pending occurrence (the most recent launch for this task).
        if let Some(idx) = c.pending.iter().rposition(|t| t == task_id) {
            c.pending.remove(idx);
            tracing::info!(target: "nightcore", task_id, "evicted uncorrelated pending launch");
            return true;
        }
        false
    }

    /// The task id a session id is bound to, if already correlated. (Read-back
    /// accessor; the reader correlates via [`correlate`](Self::correlate). Kept for
    /// diagnostics and tests.)
    #[allow(dead_code)]
    pub fn task_for(&self, session_id: u64) -> Option<String> {
        crate::sync::lock_or_recover(&self.correlation)
            .by_session
            .get(&session_id)
            .cloned()
    }

    /// Forget a session↔task binding once the run reaches a terminal state, so the
    /// map doesn't grow unboundedly across a long session.
    pub fn forget(&self, session_id: u64) {
        let mut c = crate::sync::lock_or_recover(&self.correlation);
        c.by_session.remove(&session_id);
        c.started_at.remove(&session_id);
    }

    /// The session id currently bound to `task_id`, if any. Used to interrupt a
    /// specific run by task.
    pub fn session_for(&self, task_id: &str) -> Option<u64> {
        let c = crate::sync::lock_or_recover(&self.correlation);
        c.by_session
            .iter()
            .find(|(_, t)| t.as_str() == task_id)
            .map(|(sid, _)| *sid)
    }

    /// Every currently-bound session id. Used to interrupt all in-flight runs on a
    /// stop / circuit-breaker pause.
    pub fn live_sessions(&self) -> Vec<u64> {
        crate::sync::lock_or_recover(&self.correlation)
            .by_session
            .keys()
            .copied()
            .collect()
    }

    /// Tear down provider state after the sidecar child has exited (crash recovery,
    /// #11): drop the dead stdin writer so the next [`spawn`](Self::spawn) re-spawns
    /// a fresh child, and clear ALL correlation (live bindings, pending launches,
    /// timers). Returns the task ids that had a live session bound, so the caller can
    /// fail/release their leased runs. After this, `spawn` is no longer a no-op.
    pub async fn reset_after_crash(&self) -> Vec<String> {
        // Drop the stdin handle first: a write to a dead child would error anyway,
        // and clearing it makes `spawn` re-spawn instead of returning Ok(None).
        *self.stdin.lock().await = None;
        // Drop every pending query sender so any awaiting `query` returns an error
        // (a `RecvError`) instead of hanging on a reply that will never arrive from
        // the dead child.
        crate::sync::lock_or_recover(&self.pending_replies).clear();
        let mut c = crate::sync::lock_or_recover(&self.correlation);
        let orphaned: Vec<String> = c.by_session.values().cloned().collect();
        c.by_session.clear();
        c.pending.clear();
        c.started_at.clear();
        orphaned
    }
}
