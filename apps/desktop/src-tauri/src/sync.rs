//! Poison-recovering lock helpers.
//!
//! Every `Mutex` in the core guards plain in-memory data (a task map, a slot
//! table, a correlation FIFO, settings, …) — never a half-mutated invariant that
//! a panicking thread could leave inconsistent. So a poisoned lock here is not a
//! reason to abort: recovering the guard via [`PoisonError::into_inner`] yields
//! the same data the panicking thread last left, which is exactly what we want.
//!
//! The prior `.lock().expect("…poisoned")` sites turned ONE panicking thread into
//! a whole-process crash (the next lock on that mutex re-panics). These helpers
//! make a poisoned lock recover-and-continue instead.

use std::sync::{Mutex, MutexGuard};

/// Lock `mutex`, recovering the guard if the mutex was poisoned by a prior panic.
/// The data behind the lock is plain state, so the poison flag carries no
/// correctness signal — recovery is the correct behavior, not a crash.
pub(crate) fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn locks_an_unpoisoned_mutex() {
        let m = Mutex::new(7);
        assert_eq!(*lock_or_recover(&m), 7);
    }

    #[test]
    fn recovers_the_guard_after_a_poisoning_panic() {
        // Poison the mutex: a thread panics while holding the guard. The standard
        // `.lock()` would then return `Err` forever (and `.expect` would re-panic,
        // cascading the crash); `lock_or_recover` returns the data instead.
        let m = Arc::new(Mutex::new(vec![1, 2, 3]));
        let m2 = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let mut g = lock_or_recover(&m2);
            g.push(4);
            panic!("poison the mutex while holding the guard");
        })
        .join();

        assert!(
            m.is_poisoned(),
            "the mutex is poisoned by the panicked thread"
        );
        // The recovering lock still yields the last-written state instead of crashing.
        let g = lock_or_recover(&m);
        assert_eq!(*g, vec![1, 2, 3, 4]);
    }
}
