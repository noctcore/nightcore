//! Boot phase instrumentation (#407).
//!
//! Startup was a black box: `setup` stands up logging, loads four store families,
//! prunes terminal scrollback, resolves settings, builds the orchestrator and hands a
//! dozen values to managed state — and if the first window took a second to appear,
//! nothing said which of those it was. [`BootTimer`] stamps each phase as it
//! completes, logs the per-phase timings at DEBUG, and emits ONE INFO summary line
//! naming the total and the slowest phase, so a slow boot is attributable from an
//! ordinary log file (INFO is the shipped floor) without a profiler.
//!
//! Deliberately dependency-free: a `Vec` of `(&'static str, u64)` and one `Instant`.
//! It measures the setup hook — it must never be a reason the setup hook is slow.

use std::time::Instant;

/// A single boot phase's measured duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BootPhase {
    /// Stable phase label — `snake_case`, used as the log field name.
    pub name: &'static str,
    /// Wall-clock milliseconds this phase took (time since the previous phase).
    pub elapsed_ms: u64,
}

/// Records boot phase timings. Call [`BootTimer::phase`] as each phase completes, then
/// [`BootTimer::finish`] once at the end of the setup hook.
#[derive(Debug)]
pub(crate) struct BootTimer {
    started: Instant,
    last: Instant,
    phases: Vec<BootPhase>,
}

impl BootTimer {
    /// Start the clock. Cheap enough to be the first statement in the setup hook.
    pub(crate) fn start() -> Self {
        let now = Instant::now();
        Self {
            started: now,
            last: now,
            phases: Vec::new(),
        }
    }

    /// Stamp a completed phase. `name` is a `snake_case` label; the recorded duration
    /// is the time since the previous stamp (or since [`start`](Self::start)).
    pub(crate) fn phase(&mut self, name: &'static str) {
        let now = Instant::now();
        let elapsed_ms = now.duration_since(self.last).as_millis() as u64;
        self.last = now;
        self.phases.push(BootPhase { name, elapsed_ms });
        tracing::debug!(target: "nightcore::boot", phase = name, elapsed_ms, "boot phase");
    }

    /// Total elapsed milliseconds since the timer started.
    pub(crate) fn total_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Log the one-line INFO summary: total, the per-phase breakdown, and the slowest
    /// phase (the field a slow-boot report actually needs). Consumes the timer so a
    /// boot can only be summarized once.
    pub(crate) fn finish(self) {
        let total_ms = self.total_ms();
        let slowest = slowest_phase(&self.phases);
        tracing::info!(
            target: "nightcore::boot",
            total_ms,
            phases = %format_phases(&self.phases),
            slowest = slowest.map(|p| p.name).unwrap_or("none"),
            slowest_ms = slowest.map(|p| p.elapsed_ms).unwrap_or(0),
            "boot setup complete"
        );
    }
}

/// The phase that took longest, or `None` when nothing was stamped. Ties resolve to
/// the FIRST such phase so the summary is deterministic. Pure.
fn slowest_phase(phases: &[BootPhase]) -> Option<BootPhase> {
    phases
        .iter()
        .copied()
        .reduce(|a, b| if b.elapsed_ms > a.elapsed_ms { b } else { a })
}

/// `a=1ms b=12ms` — the compact per-phase breakdown for the summary line. Pure.
fn format_phases(phases: &[BootPhase]) -> String {
    phases
        .iter()
        .map(|p| format!("{}={}ms", p.name, p.elapsed_ms))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phases_are_recorded_in_order_with_their_labels() {
        let mut t = BootTimer::start();
        t.phase("logging");
        t.phase("stores");
        t.phase("orchestrator");
        let names: Vec<&str> = t.phases.iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["logging", "stores", "orchestrator"]);
    }

    #[test]
    fn slowest_phase_picks_the_max_and_is_none_when_empty() {
        assert!(slowest_phase(&[]).is_none(), "nothing stamped ⇒ no slowest");
        let phases = [
            BootPhase {
                name: "a",
                elapsed_ms: 3,
            },
            BootPhase {
                name: "b",
                elapsed_ms: 41,
            },
            BootPhase {
                name: "c",
                elapsed_ms: 7,
            },
        ];
        assert_eq!(slowest_phase(&phases).map(|p| p.name), Some("b"));
    }

    #[test]
    fn slowest_phase_resolves_a_tie_to_the_first() {
        // Determinism matters: the same boot must not report a different culprit run
        // to run just because two phases measured equal.
        let phases = [
            BootPhase {
                name: "first",
                elapsed_ms: 9,
            },
            BootPhase {
                name: "second",
                elapsed_ms: 9,
            },
        ];
        assert_eq!(slowest_phase(&phases).map(|p| p.name), Some("first"));
    }

    #[test]
    fn format_phases_renders_the_compact_breakdown() {
        let phases = [
            BootPhase {
                name: "logging",
                elapsed_ms: 1,
            },
            BootPhase {
                name: "stores",
                elapsed_ms: 12,
            },
        ];
        assert_eq!(format_phases(&phases), "logging=1ms stores=12ms");
        assert_eq!(format_phases(&[]), "", "an unstamped boot renders empty");
    }
}
