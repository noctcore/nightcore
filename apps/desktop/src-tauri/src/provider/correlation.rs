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

    /// Test-only seam (issue #150, E2E ladder ring 1): seed a pending launch so the
    /// crate-root `e2e` MockRuntime harness can script the session↔task correlation
    /// FIFO WITHOUT spawning a real sidecar child (a real launch pushes this under the
    /// stdin lock in [`start_session`](Provider::start_session), which needs a live
    /// child). Gated to `#[cfg(test)]`, so it is never compiled into the app and
    /// changes no production behavior — it only re-exposes the existing
    /// `pub(super) push_pending` to the in-crate harness.
    #[cfg(test)]
    pub(crate) fn push_pending_for_test(&self, task_id: &str) {
        self.push_pending(task_id);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn provider() -> SidecarProvider {
        SidecarProvider::new(
            PathBuf::from("/tmp/entry.ts"),
            PathBuf::from("/tmp"),
            "claude".to_string(),
        )
    }

    #[test]
    fn correlation_binds_in_fifo_order() {
        let p = provider();
        // Two launches queued in order; the engine assigns ids 0 then 1.
        p.push_pending("task-a");
        p.push_pending("task-b");

        assert_eq!(p.correlate(0).as_deref(), Some("task-a"));
        assert_eq!(p.correlate(1).as_deref(), Some("task-b"));
        // Re-seeing a bound id returns the same task (idempotent).
        assert_eq!(p.correlate(0).as_deref(), Some("task-a"));
    }

    #[test]
    fn correlate_with_no_pending_launch_is_none() {
        let p = provider();
        assert!(
            p.correlate(7).is_none(),
            "an event with no pending launch can't be correlated (FIFO desync)"
        );
    }

    #[test]
    fn binding_follows_fifo_order_not_session_id_magnitude() {
        // The FIFO binds the i-th session-started to the i-th launch regardless of
        // the numeric id: the engine's ids need not be monotonic vs. launch order.
        // Here the first session id (900) is larger than the second (5), yet they
        // still bind a→900, b→5 by push order.
        let p = provider();
        p.push_pending("task-a");
        p.push_pending("task-b");
        assert_eq!(p.correlate(900).as_deref(), Some("task-a"));
        assert_eq!(p.correlate(5).as_deref(), Some("task-b"));
        assert_eq!(p.task_for(900).as_deref(), Some("task-a"));
        assert_eq!(p.task_for(5).as_deref(), Some("task-b"));
    }

    #[test]
    fn task_for_reads_back_a_binding() {
        let p = provider();
        p.push_pending("task-x");
        assert!(p.task_for(3).is_none(), "unseen id is unbound");
        p.correlate(3);
        assert_eq!(p.task_for(3).as_deref(), Some("task-x"));
    }

    #[test]
    fn forget_drops_a_binding() {
        let p = provider();
        p.push_pending("t");
        p.correlate(5);
        assert_eq!(p.task_for(5).as_deref(), Some("t"));
        p.forget(5);
        assert!(p.task_for(5).is_none(), "binding cleared on terminal");
    }

    #[test]
    fn concurrent_launches_keep_their_own_sessions() {
        // Three tasks launched before any session-started arrives (true M2
        // concurrency); ids come back interleaved-but-ordered.
        let p = provider();
        for id in ["a", "b", "c"] {
            p.push_pending(id);
        }
        assert_eq!(p.correlate(10).as_deref(), Some("a"));
        assert_eq!(p.correlate(11).as_deref(), Some("b"));
        assert_eq!(p.correlate(12).as_deref(), Some("c"));
        assert_eq!(p.task_for(11).as_deref(), Some("b"));
    }

    #[test]
    fn evict_pending_removes_an_uncorrelated_launch() {
        // concurrency #5: a launch cancelled before its session-started must be
        // evicted so the FIFO doesn't mis-bind a later session to the dead launch.
        let p = provider();
        p.push_pending("task-a");
        p.push_pending("task-b");

        // task-a is cancelled before any session arrives → evict its pending entry.
        assert!(
            p.evict_pending("task-a"),
            "an uncorrelated launch is evicted"
        );
        // Now the FIFO head is task-b; the next session binds to it (not to task-a).
        assert_eq!(p.correlate(0).as_deref(), Some("task-b"));
        // A second evict of the same task is a no-op (nothing pending left).
        assert!(!p.evict_pending("task-a"));
    }

    #[test]
    fn evict_pending_is_a_noop_once_correlated() {
        // Once a launch has correlated to a session, evict_pending must NOT touch it
        // (the binding is dropped by `forget` on terminal, not by eviction).
        let p = provider();
        p.push_pending("task-a");
        p.correlate(7);
        assert!(
            !p.evict_pending("task-a"),
            "a correlated launch is not evicted"
        );
        assert_eq!(p.task_for(7).as_deref(), Some("task-a"), "binding intact");
    }

    #[test]
    fn evict_pending_removes_only_the_most_recent_launch_for_a_task() {
        // A task can appear twice in the FIFO (a launch, then a re-launch) before
        // either correlates. Eviction removes the LAST occurrence (matching
        // `rposition`), so the older launch still correlates in order.
        let p = provider();
        p.push_pending("task-a"); // launch #1
        p.push_pending("task-b");
        p.push_pending("task-a"); // launch #2 (re-launch)

        // Tear down the most-recent task-a launch before any session arrives.
        assert!(
            p.evict_pending("task-a"),
            "the most-recent uncorrelated launch is evicted"
        );

        // The FIFO is now [task-a#1, task-b]: the earlier task-a still binds first.
        assert_eq!(
            p.correlate(0).as_deref(),
            Some("task-a"),
            "the earlier launch survives eviction of the later one"
        );
        assert_eq!(p.correlate(1).as_deref(), Some("task-b"));
        // task-a has now correlated, so a further evict is a no-op.
        assert!(!p.evict_pending("task-a"));
    }

    #[test]
    fn run_duration_ms_tracks_until_forgotten() {
        let p = provider();
        p.push_pending("t");
        // An uncorrelated session has no start time yet.
        assert!(
            p.run_duration_ms(3).is_none(),
            "unseen session has no start time"
        );
        p.correlate(3);
        assert!(
            p.run_duration_ms(3).is_some(),
            "a correlated session has a start time to measure duration from"
        );
        p.forget(3);
        assert!(
            p.run_duration_ms(3).is_none(),
            "forget clears the run timer alongside the binding"
        );
    }

    #[test]
    fn session_for_and_live_sessions_reflect_bindings() {
        let p = provider();
        p.push_pending("task-a");
        p.push_pending("task-b");
        // No bindings yet.
        assert!(p.session_for("task-a").is_none());
        assert!(p.live_sessions().is_empty());

        p.correlate(100);
        p.correlate(200);
        assert_eq!(
            p.session_for("task-a"),
            Some(100),
            "task-a is bound to its session for a by-task interrupt"
        );
        assert_eq!(p.session_for("task-b"), Some(200));
        assert!(p.session_for("task-unknown").is_none());

        let mut live = p.live_sessions();
        live.sort_unstable();
        assert_eq!(
            live,
            vec![100, 200],
            "every bound session is listed for interrupt-all"
        );

        // Forgetting one drops it from both accessors.
        p.forget(100);
        assert!(p.session_for("task-a").is_none());
        assert_eq!(p.live_sessions(), vec![200]);
    }

    #[tokio::test]
    async fn reset_after_crash_returns_orphaned_and_clears_all_state() {
        // crash recovery (#11): after the sidecar child dies, reset returns exactly
        // the tasks that had a live session (so the caller can fail/release their
        // leased runs) and clears every correlation so the next spawn starts clean.
        let p = provider();
        // Two launches correlate to live sessions; a third stays pending.
        p.push_pending("task-a");
        p.push_pending("task-b");
        p.push_pending("task-c");
        assert_eq!(p.correlate(0).as_deref(), Some("task-a"));
        assert_eq!(p.correlate(1).as_deref(), Some("task-b"));
        // task-c never correlated (still pending).

        let mut orphaned = p.reset_after_crash().await;
        orphaned.sort();
        assert_eq!(
            orphaned,
            vec!["task-a".to_string(), "task-b".to_string()],
            "only tasks with a live session are reported for fail/release"
        );

        // Everything is cleared: live bindings, run timers, and the pending FIFO.
        assert!(p.task_for(0).is_none(), "live bindings cleared");
        assert!(p.task_for(1).is_none());
        assert!(p.run_duration_ms(0).is_none(), "run timers cleared");
        assert!(p.live_sessions().is_empty());
        // The pending FIFO was cleared too, so a post-reset session can't mis-bind to
        // the pre-crash task-c launch.
        assert!(
            p.correlate(9).is_none(),
            "pending launches cleared — no stale mis-bind after a crash"
        );
    }
}
