//! Concurrency / slot manager (M2 §3 of the design doc) — SKELETON.
//!
//! Caps parallel runs at `max` and holds an abort handle per run. This is the
//! generalization of M1's serial guard: M1's `Sidecar.active_task:
//! Mutex<Option<String>>` is exactly a `SlotManager` with `max == 1`. The skeleton
//! below implements the slot-counting (pure, testable now) but leaves the abort
//! handle as a `TODO(m2)` because it needs the real run-cancellation wiring
//! (`tokio` task / provider interrupt) that doesn't exist until the coordinator
//! lands.

use std::collections::HashSet;
use std::sync::Mutex;

/// Bounded parallel-run gate. `try_lease` admits a task only while a slot is free;
/// `release` frees one. The M1 "a task is already running" behavior is the
/// `max == 1` case.
pub struct SlotManager {
    max: usize,
    leased: Mutex<HashSet<String>>,
    // TODO(m2): per-task abort handles so the circuit breaker / cancel_task can
    // interrupt in-flight runs:
    //   leases: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl SlotManager {
    /// A manager with `max` parallel slots. `max = 1` reproduces M1's serial guard.
    pub fn new(max: usize) -> Self {
        Self {
            max: max.max(1),
            leased: Mutex::new(HashSet::new()),
        }
    }

    /// Claim a slot for `task_id`. Returns `false` when no slot is free (the
    /// generalization of M1's `Sidecar::active().is_some()` rejection) or the task
    /// already holds one.
    pub fn try_lease(&self, task_id: &str) -> bool {
        let mut leased = self.leased.lock().expect("slot manager poisoned");
        if leased.len() >= self.max || leased.contains(task_id) {
            return false;
        }
        leased.insert(task_id.to_string());
        true
    }

    /// Release `task_id`'s slot. Idempotent.
    pub fn release(&self, task_id: &str) {
        self.leased
            .lock()
            .expect("slot manager poisoned")
            .remove(task_id);
    }

    /// Slots currently free.
    pub fn free_slots(&self) -> usize {
        let leased = self.leased.lock().expect("slot manager poisoned").len();
        self.max.saturating_sub(leased)
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
}
