//! Concurrency / slot manager (M2 §3 of the design doc).
//!
//! Caps parallel runs at `max` and holds an abort handle per run. This is the
//! generalization of M1's serial guard: M1's `Sidecar.active_task:
//! Mutex<Option<String>>` is exactly a `SlotManager` with `max == 1`. A lease both
//! reserves a slot and (once the run is dispatched) carries the
//! [`tokio::task::AbortHandle`] that `cancel_task` and the circuit breaker use to
//! kill the in-flight run.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tokio::task::AbortHandle;

/// One reserved slot. The abort handle is attached after the run's driver task is
/// spawned (`attach_abort`); a lease with no handle yet is a reservation whose
/// dispatch is still in flight.
struct Lease {
    abort: Option<AbortHandle>,
}

/// Bounded parallel-run gate. `try_lease` admits a task only while a slot is free;
/// `release` frees one. The M1 "a task is already running" behavior is the
/// `max == 1` case. `max` is interior-mutable so `set_max_concurrency` can resize
/// the pool live.
pub struct SlotManager {
    max: AtomicUsize,
    leased: Mutex<HashMap<String, Lease>>,
}

impl SlotManager {
    /// A manager with `max` parallel slots. `max = 1` reproduces M1's serial guard;
    /// `0` clamps up to `1` (a pool must admit at least one run).
    pub fn new(max: usize) -> Self {
        Self {
            max: AtomicUsize::new(max.max(1)),
            leased: Mutex::new(HashMap::new()),
        }
    }

    /// The current parallel-run cap.
    pub fn max(&self) -> usize {
        self.max.load(Ordering::Relaxed)
    }

    /// Resize the pool. Clamps up to `1`. Shrinking below the live lease count does
    /// **not** abort runs already in flight — they drain naturally and the next
    /// `free_slots` simply reports `0` until enough release. Returns the new cap.
    pub fn set_max(&self, max: usize) -> usize {
        let max = max.max(1);
        self.max.store(max, Ordering::Relaxed);
        max
    }

    /// Claim a slot for `task_id`. Returns `false` when no slot is free (the
    /// generalization of M1's `Sidecar::active().is_some()` rejection) or the task
    /// already holds one. The lease starts without an abort handle; the coordinator
    /// attaches one via [`attach_abort`](Self::attach_abort) once it spawns the
    /// run's driver task.
    pub fn try_lease(&self, task_id: &str) -> bool {
        let mut leased = crate::sync::lock_or_recover(&self.leased);
        if leased.len() >= self.max() || leased.contains_key(task_id) {
            return false;
        }
        leased.insert(task_id.to_string(), Lease { abort: None });
        true
    }

    /// Attach the abort handle for an already-leased task. No-op if the task holds
    /// no lease (e.g. it was released by a race) — the handle is simply dropped.
    ///
    /// M2's effective cancellation is `provider.interrupt(session_id)` (a run lives
    /// in the sidecar process, not a tokio task), so the coordinator does not yet
    /// spawn a per-run driver to attach. This is kept as the design-specified seam
    /// for a future provider whose run *is* a local task; exercised by the slots
    /// abort test.
    #[allow(dead_code)]
    pub fn attach_abort(&self, task_id: &str, abort: AbortHandle) {
        let mut leased = crate::sync::lock_or_recover(&self.leased);
        if let Some(lease) = leased.get_mut(task_id) {
            lease.abort = Some(abort);
        }
    }

    /// Whether `task_id` currently holds a slot.
    pub fn is_leased(&self, task_id: &str) -> bool {
        crate::sync::lock_or_recover(&self.leased).contains_key(task_id)
    }

    /// Release `task_id`'s slot and drop its abort handle. Idempotent.
    pub fn release(&self, task_id: &str) {
        crate::sync::lock_or_recover(&self.leased).remove(task_id);
    }

    /// Abort `task_id`'s run (if a handle is attached) and release its slot.
    /// Returns whether a slot was held. The abort cancels the spawned driver task;
    /// the provider interrupt it issues produces the terminal `session-failed`.
    pub fn abort(&self, task_id: &str) -> bool {
        let lease = crate::sync::lock_or_recover(&self.leased).remove(task_id);
        match lease {
            Some(lease) => {
                if let Some(handle) = lease.abort {
                    handle.abort();
                }
                true
            }
            None => false,
        }
    }

    /// Abort every in-flight run and free all slots. Used by `stop_auto_loop` and
    /// the circuit-breaker pause.
    pub fn abort_all(&self) {
        let mut leased = crate::sync::lock_or_recover(&self.leased);
        for (_, lease) in leased.drain() {
            if let Some(handle) = lease.abort {
                handle.abort();
            }
        }
    }

    /// Slots currently free: `max - leased`, saturating (a shrunk pool reports 0
    /// rather than underflowing).
    pub fn free_slots(&self) -> usize {
        let leased = crate::sync::lock_or_recover(&self.leased).len();
        self.max().saturating_sub(leased)
    }

    /// Number of runs currently holding a slot.
    pub fn leased_count(&self) -> usize {
        crate::sync::lock_or_recover(&self.leased).len()
    }
}

impl Default for SlotManager {
    fn default() -> Self {
        Self::new(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_one_reproduces_the_m1_serial_guard() {
        // With one slot, the SlotManager is the M1 "a task is already running"
        // guard: the first lease succeeds, a second is refused until release.
        let slots = SlotManager::new(1);
        assert_eq!(slots.free_slots(), 1);

        assert!(slots.try_lease("task-1"), "first run claims the slot");
        assert!(
            !slots.try_lease("task-2"),
            "second run is refused while one is active (M1 serial guard)"
        );
        assert_eq!(slots.free_slots(), 0);

        slots.release("task-1");
        assert_eq!(slots.free_slots(), 1);
        assert!(slots.try_lease("task-2"), "slot freed → next run admitted");
    }

    #[test]
    fn admits_up_to_max_parallel_runs() {
        let slots = SlotManager::new(2);
        assert!(slots.try_lease("a"));
        assert!(slots.try_lease("b"));
        assert!(!slots.try_lease("c"), "third run exceeds max=2");
        assert_eq!(slots.free_slots(), 0);
    }

    #[test]
    fn re_leasing_the_same_task_is_refused() {
        let slots = SlotManager::new(2);
        assert!(slots.try_lease("a"));
        assert!(!slots.try_lease("a"), "a task can't hold two slots");
        assert_eq!(slots.free_slots(), 1);
    }

    #[test]
    fn release_is_idempotent() {
        let slots = SlotManager::new(1);
        slots.release("never-leased"); // no panic
        assert!(slots.try_lease("a"));
        slots.release("a");
        slots.release("a"); // double release is a no-op
        assert_eq!(slots.free_slots(), 1);
    }

    #[test]
    fn max_is_clamped_to_at_least_one() {
        let slots = SlotManager::new(0);
        assert_eq!(slots.free_slots(), 1, "max must clamp up to 1");
    }

    #[test]
    fn set_max_resizes_the_pool() {
        let slots = SlotManager::new(1);
        assert!(slots.try_lease("a"));
        assert_eq!(slots.free_slots(), 0);

        // Growing the pool frees capacity for more parallel runs immediately.
        slots.set_max(3);
        assert_eq!(slots.max(), 3);
        assert_eq!(slots.free_slots(), 2, "one leased, two now free");
        assert!(slots.try_lease("b"));
        assert!(slots.try_lease("c"));
        assert!(!slots.try_lease("d"), "back at capacity");
    }

    #[test]
    fn set_max_clamps_to_one_and_shrinks_without_aborting() {
        let slots = SlotManager::new(3);
        assert!(slots.try_lease("a"));
        assert!(slots.try_lease("b"));

        // Shrinking below the live count leaves the runs in flight; free_slots
        // saturates at 0 rather than underflowing.
        slots.set_max(0);
        assert_eq!(slots.max(), 1, "0 clamps to 1");
        assert_eq!(slots.free_slots(), 0);
        assert_eq!(slots.leased_count(), 2, "in-flight runs are not aborted");
    }

    #[test]
    fn abort_releases_the_slot() {
        // Without a tokio runtime we can't build a real AbortHandle, but abort()
        // must still free the slot for a lease that has no handle attached yet.
        let slots = SlotManager::new(1);
        assert!(slots.try_lease("a"));
        assert!(slots.abort("a"), "abort reports the slot was held");
        assert_eq!(slots.free_slots(), 1, "abort frees the slot");
        assert!(!slots.abort("a"), "aborting a freed slot reports false");
    }

    #[test]
    fn abort_all_frees_every_slot() {
        let slots = SlotManager::new(3);
        assert!(slots.try_lease("a"));
        assert!(slots.try_lease("b"));
        assert_eq!(slots.leased_count(), 2);
        slots.abort_all();
        assert_eq!(slots.leased_count(), 0);
        assert_eq!(slots.free_slots(), 3);
    }

    #[tokio::test]
    async fn attached_abort_handle_cancels_the_driver_task() {
        let slots = SlotManager::new(1);
        assert!(slots.try_lease("a"));

        // A long-lived task standing in for a run's driver; the lease's abort
        // handle must cancel it.
        let task = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        });
        slots.attach_abort("a", task.abort_handle());
        assert!(slots.abort("a"));

        let joined = task.await;
        assert!(joined.is_err(), "the driver task was aborted");
        assert!(joined.unwrap_err().is_cancelled());
    }

    /// The M1 serial guard, now expressed through the slot manager at max=1:
    /// `run_task` rejects with no free slot whenever one is held. (The full command
    /// needs an `AppHandle` we can't build in a unit test; the decision is purely
    /// `SlotManager::try_lease`.)
    #[test]
    fn serial_guard_is_max_one_slot() {
        let slots = SlotManager::new(1);
        assert!(slots.try_lease("task-1"), "first run claims the slot");
        assert!(
            !slots.try_lease("task-2"),
            "a second run is refused while one holds the only slot"
        );
        slots.release("task-1");
        assert!(slots.try_lease("task-2"), "freed slot admits the next run");
    }

    /// A terminal event releases the slot, letting the next run pass the guard —
    /// the M2 equivalent of M1's `set_active(None)` on completion.
    #[test]
    fn terminal_event_frees_the_slot() {
        let slots = SlotManager::new(1);
        slots.try_lease("task-1");
        assert_eq!(slots.free_slots(), 0);
        slots.release("task-1"); // finish_run does this on a terminal event
        assert_eq!(slots.free_slots(), 1);
    }
}
