//! Mid-run sidecar-crash recovery, composed over the real subsystems.
//!
//! When the sidecar child dies mid-run, the in-memory run state (slot leases, the
//! session↔task map, run timers) is stale: the dead child will never emit the
//! terminal events that would release those slots. `SidecarProvider::reset_after_crash`
//! is the recovery seam — it returns exactly the tasks that had a live session (so
//! the caller can fail/release their leased runs) and clears ALL correlation so the
//! next spawn starts clean and no post-crash session mis-binds to a pre-crash launch.
//! This scenario drives that seam composed with the real `SlotManager` + `TaskStore`.
//!
//! (The BOOT requeue path — `reconcile_tasks` resetting persisted `InProgress`/
//! `Verifying` tasks to `Ready` — has its own pure-core + store-composition tests in
//! `orchestration::coordinator::reconcile`; this module covers the complementary
//! live-crash path, which those don't.)

use crate::task::{RunMode, TaskKind, TaskStatus};

use super::harness::TestApp;

#[tokio::test]
async fn sidecar_crash_reset_returns_orphans_releases_slots_and_clears_correlation() {
    let h = TestApp::boot(3);

    // Two tasks are in flight (leased + correlated); a third launch is pending but
    // never correlated (its session-started never arrived before the crash).
    let a = h.create_backlog_task(TaskKind::Build, RunMode::Worktree);
    let b = h.create_backlog_task(TaskKind::Build, RunMode::Worktree);
    let pending = h.create_backlog_task(TaskKind::Build, RunMode::Worktree);

    assert!(h.lease_and_mark_in_progress(&a));
    assert!(h.lease_and_mark_in_progress(&b));
    h.script_session_started(&a, 1);
    h.script_session_started(&b, 2);
    // A third launch leased a slot and pushed a pending entry but never correlated.
    assert!(h.lease_and_mark_in_progress(&pending));
    h.provider().push_pending_for_test(&pending);
    assert_eq!(
        h.orch().slots.leased_count(),
        3,
        "three runs in flight before the crash"
    );

    // The sidecar child dies → reset. It reports the tasks with a live session.
    // Both sides are sorted before comparison: `reset_after_crash` collects from a
    // HashMap (unordered) AND the task ids are random UUIDs, so the expected vec must
    // be sorted too — comparing a sorted result to a creation-ordered vec is a flake.
    let mut orphaned = h.provider().reset_after_crash().await;
    orphaned.sort();
    let mut expected = vec![a.clone(), b.clone()];
    expected.sort();
    assert_eq!(
        orphaned, expected,
        "only tasks with a correlated live session are reported for fail/release"
    );

    // All correlation is cleared: no live bindings survive, and a post-crash session
    // id can't mis-bind to the pre-crash `pending` launch.
    assert!(
        h.provider().live_sessions().is_empty(),
        "live bindings cleared"
    );
    assert!(h.provider().task_for(1).is_none());
    assert!(
        h.provider().correlate(9).is_none(),
        "the pending FIFO was cleared — no stale mis-bind after the crash"
    );

    // The caller fails + releases each orphaned run (the production recovery action);
    // the never-correlated `pending` run is released too. After recovery no slot leaks.
    for id in [&a, &b, &pending] {
        h.store()
            .mutate(id, |t| {
                t.status = TaskStatus::Failed;
                t.session_id = None;
                t.error = Some("sidecar crashed — run reset".into());
            })
            .unwrap();
        h.orch().slots.release(id);
    }
    assert_eq!(
        h.orch().slots.leased_count(),
        0,
        "every crashed run released its slot"
    );
    assert_eq!(h.status(&a), TaskStatus::Failed);
    assert!(
        h.task(&a).session_id.is_none(),
        "the stale dead-session id is cleared"
    );
}

#[tokio::test]
async fn reset_after_crash_is_idempotent_on_a_clean_provider() {
    // A reset with no in-flight sessions returns no orphans and leaves the slot pool
    // untouched — recovery is safe to run even when nothing was stranded.
    let h = TestApp::boot(1);
    let orphaned = h.provider().reset_after_crash().await;
    assert!(orphaned.is_empty(), "no live sessions ⇒ no orphans");
    assert_eq!(h.orch().slots.leased_count(), 0);
}
