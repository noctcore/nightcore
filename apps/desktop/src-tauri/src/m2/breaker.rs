//! Failure circuit-breaker (M2 §6 of the design doc).
//!
//! Pauses the auto-loop after `threshold` failures inside a sliding `window` so a
//! broken setup (auth gone, repo wedged) doesn't burn through the whole board. A
//! success clears the window; a failure pushes a timestamp, evicts stale ones, and
//! trips when the live count reaches the threshold. `is_paused` gates the
//! coordinator tick; `reset` (the `resume_auto_loop` command) clears the pause and
//! the window so the user can retry after fixing the cause.
//!
//! Time is injected (`record_failure_at` / `now`) so the trip logic is unit-tested
//! deterministically without sleeping. The default `record_failure` uses
//! `Instant::now`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Default consecutive-failure threshold before the loop pauses (design §6).
pub const DEFAULT_THRESHOLD: usize = 3;
/// Default sliding window for counting failures (design §6).
pub const DEFAULT_WINDOW: Duration = Duration::from_secs(60);

/// Sliding-window failure counter that latches a `paused` flag once tripped.
pub struct CircuitBreaker {
    threshold: usize,
    window: Duration,
    failures: Mutex<VecDeque<Instant>>,
    paused: AtomicBool,
}

impl CircuitBreaker {
    /// A breaker that trips after `threshold` failures within `window`.
    pub fn new(threshold: usize, window: Duration) -> Self {
        Self {
            threshold: threshold.max(1),
            window,
            failures: Mutex::new(VecDeque::new()),
            paused: AtomicBool::new(false),
        }
    }

    /// A success clears the failure window: the consecutive-failure count resets,
    /// so an intermittent failure between successes never trips the breaker.
    pub fn record_success(&self) {
        self.failures.lock().expect("breaker poisoned").clear();
    }

    /// Record a failure at `now`, evicting entries older than the window. Trips
    /// (`paused = true`) when the live count reaches the threshold. Returns whether
    /// this failure *caused* the trip (false if already paused or below threshold).
    pub fn record_failure_at(&self, now: Instant) -> bool {
        let mut failures = self.failures.lock().expect("breaker poisoned");
        let cutoff = now.checked_sub(self.window);
        if let Some(cutoff) = cutoff {
            while failures.front().is_some_and(|t| *t < cutoff) {
                failures.pop_front();
            }
        }
        failures.push_back(now);

        if failures.len() >= self.threshold && !self.paused.swap(true, Ordering::SeqCst) {
            return true; // this failure tripped the breaker
        }
        false
    }

    /// Record a failure at the current instant.
    pub fn record_failure(&self) -> bool {
        self.record_failure_at(Instant::now())
    }

    /// Whether the breaker is currently tripped (the coordinator tick is gated on
    /// this being `false`).
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    /// Clear the pause and the failure window — the `resume_auto_loop` path. The
    /// user has fixed the cause and wants the loop to retry from a clean slate.
    pub fn reset(&self) {
        self.paused.store(false, Ordering::SeqCst);
        self.failures.lock().expect("breaker poisoned").clear();
    }

    /// The configured trip threshold (for the `nc:loop` payload / diagnostics).
    pub fn threshold(&self) -> usize {
        self.threshold
    }
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self::new(DEFAULT_THRESHOLD, DEFAULT_WINDOW)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trips_after_threshold_consecutive_failures() {
        let cb = CircuitBreaker::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(!cb.record_failure_at(t0), "first failure does not trip");
        assert!(!cb.is_paused());
        assert!(!cb.record_failure_at(t0 + Duration::from_secs(1)));
        assert!(
            cb.record_failure_at(t0 + Duration::from_secs(2)),
            "third failure within the window trips"
        );
        assert!(cb.is_paused(), "breaker is now paused");
    }

    #[test]
    fn success_resets_the_window() {
        let cb = CircuitBreaker::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        cb.record_failure_at(t0);
        cb.record_failure_at(t0 + Duration::from_secs(1));
        // A success between failures clears the count, so the next two don't trip.
        cb.record_success();
        assert!(!cb.record_failure_at(t0 + Duration::from_secs(2)));
        assert!(!cb.record_failure_at(t0 + Duration::from_secs(3)));
        assert!(!cb.is_paused(), "two post-success failures stay under threshold");
    }

    #[test]
    fn stale_failures_fall_out_of_the_window() {
        let cb = CircuitBreaker::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        cb.record_failure_at(t0);
        cb.record_failure_at(t0 + Duration::from_secs(1));
        // The first two are now older than the 60s window; only the recent one
        // counts, so this does not trip.
        assert!(!cb.record_failure_at(t0 + Duration::from_secs(90)));
        assert!(!cb.is_paused());
    }

    #[test]
    fn reset_clears_pause_and_window() {
        let cb = CircuitBreaker::new(2, Duration::from_secs(60));
        let t0 = Instant::now();
        cb.record_failure_at(t0);
        assert!(cb.record_failure_at(t0 + Duration::from_secs(1)));
        assert!(cb.is_paused());

        cb.reset();
        assert!(!cb.is_paused(), "resume clears the pause");
        // The window was cleared too: it takes a fresh `threshold` failures to trip
        // again.
        assert!(!cb.record_failure_at(t0 + Duration::from_secs(2)));
        assert!(cb.record_failure_at(t0 + Duration::from_secs(3)));
    }

    #[test]
    fn only_the_tripping_failure_reports_true() {
        let cb = CircuitBreaker::new(1, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(cb.record_failure_at(t0), "threshold 1 trips on first failure");
        // Already paused: subsequent failures don't re-report the trip.
        assert!(!cb.record_failure_at(t0 + Duration::from_secs(1)));
    }

    #[test]
    fn defaults_match_the_design() {
        let cb = CircuitBreaker::default();
        assert_eq!(cb.threshold(), DEFAULT_THRESHOLD);
        assert_eq!(DEFAULT_THRESHOLD, 3);
        assert_eq!(DEFAULT_WINDOW, Duration::from_secs(60));
    }
}
