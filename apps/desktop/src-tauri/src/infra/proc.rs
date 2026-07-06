//! Wall-clock-bounded child waiting (the `oneshot` poll pattern, shared).
//!
//! `std::process` has no deadline on `wait`/`wait_with_output`, so a child that
//! never exits — a `git push` against a black-holed origin, a hung `gh` — pins
//! its blocking thread (and any lease the caller holds) forever. This helper is
//! the reusable form of the try_wait poll-with-deadline + kill loop that
//! `workflow::oneshot` proved out: callers spawn the child themselves
//! (keeping their own env/cwd/pipe setup — e.g. the git-env isolation
//! chokepoint), drain its pipes on threads, and bound the wait here.

use std::process::{Child, ExitStatus};
use std::time::{Duration, Instant};

/// How often the deadline loop polls `try_wait`. Coarse enough to stay cheap,
/// fine enough that a fast child adds ≤50ms of latency.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Poll `child` for exit, bounded by `deadline`. Returns:
/// - `Ok(Some(status))` — the child exited within the deadline;
/// - `Ok(None)` — the deadline elapsed; the child was killed AND reaped (its
///   pipes are closed, unblocking any drain threads) before returning;
/// - `Err(e)` — the wait itself failed; the child was killed + reaped too.
///
/// The caller must take/drain the child's piped output on separate threads
/// BEFORE calling this (a full pipe buffer would otherwise deadlock the child),
/// exactly as `oneshot::run_oneshot` does.
pub(crate) fn wait_with_deadline(
    child: &mut Child,
    deadline: Duration,
) -> std::io::Result<Option<ExitStatus>> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) => {
                if start.elapsed() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(None);
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            // Symmetric with the timeout arm: reap the child and close its pipes
            // (unblocking any writer/reader threads) before surfacing the error.
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    #[cfg(unix)]
    fn wait_with_deadline_kills_a_child_that_overruns() {
        // A child that sleeps well past the deadline must come back Ok(None)
        // quickly (killed + reaped), not pin the caller for the full sleep.
        let mut child = Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleeper");
        let start = Instant::now();
        let status = wait_with_deadline(&mut child, Duration::from_millis(200)).expect("wait");
        assert!(status.is_none(), "an overrunning child times out");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "the kill returns promptly, not after the child's sleep"
        );
        // The child was reaped: a second wait errors or returns the kill status
        // immediately rather than blocking.
        let reaped = child.try_wait().expect("try_wait after reap");
        assert!(reaped.is_some(), "the child was reaped by the helper");
    }

    #[test]
    #[cfg(unix)]
    fn wait_with_deadline_returns_the_status_of_a_fast_child() {
        let mut child = Command::new("sh")
            .args(["-c", "exit 3"])
            .spawn()
            .expect("spawn");
        let status = wait_with_deadline(&mut child, Duration::from_secs(10))
            .expect("wait")
            .expect("exited within the deadline");
        assert_eq!(status.code(), Some(3), "the real exit code is preserved");
    }
}
