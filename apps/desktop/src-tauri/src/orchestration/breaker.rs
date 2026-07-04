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

use crate::contracts::ErrorCategory;

/// Whether a failure of this structured [`ErrorCategory`] should trip the breaker
/// IMMEDIATELY rather than accumulate toward the sliding-window threshold. A
/// fatal-setup cause won't fix itself by running more tasks — auth is broken for
/// every task under the same credential, and a full disk fails every write — so
/// the loop stops at once instead of burning two more tasks proving the point.
/// Transient causes (rate-limit, runner-crash, unknown) keep the tolerant window
/// so a single blip doesn't pause the board. `aborted`/`resource-exhausted` never
/// reach this decision as breaker-feeding failures (they're handled upstream), but
/// are classified conservatively as non-immediate for exhaustiveness.
pub fn trips_breaker_immediately(category: ErrorCategory) -> bool {
    matches!(category, ErrorCategory::Auth | ErrorCategory::DiskFull)
}

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
        crate::sync::lock_or_recover(&self.failures).clear();
    }

    /// Record a failure at `now`, evicting entries older than the window. Trips
    /// (`paused = true`) when the live count reaches the threshold. Returns whether
    /// this failure *caused* the trip (false if already paused or below threshold).
    pub fn record_failure_at(&self, now: Instant) -> bool {
        let mut failures = crate::sync::lock_or_recover(&self.failures);
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

    /// Record a FATAL-setup failure (an `auth`/`disk-full` category): trip the
    /// breaker at once, regardless of the sliding-window threshold, because
    /// retrying more tasks under the same broken environment just burns the
    /// board. Returns whether THIS failure caused the trip (false if already
    /// paused), mirroring [`record_failure_at`]'s contract so the caller pauses +
    /// interrupts identically. The failure window is untouched (the latch alone
    /// pauses the loop; `reset` clears it on resume).
    pub fn record_fatal_failure(&self) -> bool {
        !self.paused.swap(true, Ordering::SeqCst)
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
        crate::sync::lock_or_recover(&self.failures).clear();
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
        assert!(
            !cb.is_paused(),
            "two post-success failures stay under threshold"
        );
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
        assert!(
            cb.record_failure_at(t0),
            "threshold 1 trips on first failure"
        );
        // Already paused: subsequent failures don't re-report the trip.
        assert!(!cb.record_failure_at(t0 + Duration::from_secs(1)));
    }

    #[test]
    fn fatal_failure_trips_on_the_first_hit_below_threshold() {
        // A structured auth/disk-full failure must stop the loop AT ONCE — even
        // with a high threshold and an empty window — so the board doesn't burn
        // two more tasks under a broken credential/full disk.
        let cb = CircuitBreaker::new(3, Duration::from_secs(60));
        assert!(!cb.is_paused());
        assert!(cb.record_fatal_failure(), "first fatal failure trips");
        assert!(cb.is_paused(), "the loop is paused immediately");
        // Already paused: a second fatal hit does not re-report the trip.
        assert!(!cb.record_fatal_failure());
    }

    #[test]
    fn category_branch_decides_immediate_vs_windowed() {
        // The real category-based branch the reader/finish_run key off: auth and
        // disk-full stop the loop at once; transient categories stay windowed.
        assert!(trips_breaker_immediately(ErrorCategory::Auth));
        assert!(trips_breaker_immediately(ErrorCategory::DiskFull));
        assert!(!trips_breaker_immediately(ErrorCategory::RateLimit));
        assert!(!trips_breaker_immediately(ErrorCategory::RunnerCrash));
        assert!(!trips_breaker_immediately(ErrorCategory::Unknown));
        assert!(!trips_breaker_immediately(ErrorCategory::ResourceExhausted));
    }

    #[test]
    fn transient_failures_below_threshold_do_not_trip_even_after_a_reset() {
        // Contrast with the fatal path: a windowed (transient) failure needs the
        // full threshold to trip, proving the two paths really diverge.
        let cb = CircuitBreaker::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        assert!(!cb.record_failure_at(t0));
        assert!(!cb.record_failure_at(t0 + Duration::from_secs(1)));
        assert!(
            !cb.is_paused(),
            "two transient failures stay under threshold"
        );
    }

    #[test]
    fn defaults_match_the_design() {
        let cb = CircuitBreaker::default();
        assert_eq!(cb.threshold(), DEFAULT_THRESHOLD);
        assert_eq!(DEFAULT_THRESHOLD, 3);
        assert_eq!(DEFAULT_WINDOW, Duration::from_secs(60));
    }
}
