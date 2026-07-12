//! Shared transcript-replay plumbing: turn a checked-in `.jsonl` fixture into the
//! ordered `serde_json::Value` events a real sidecar stdout stream would carry, in
//! wire order.
//!
//! Each fixture line is one serialized sidecar event — the exact shape the reader
//! parses off the sidecar's stdout (and the shape the on-disk task transcript is
//! written in). The per-run-kind drivers (`super::build`, `super::scan`,
//! `super::pr_review`) feed these events one at a time through the reader's
//! `AppHandle`-free correlation + finalizer seams and assert the resulting store
//! state + the emitted-event sequence.

use serde_json::Value;

/// Parse an NDJSON transcript fixture into its ordered events. Blank lines are
/// skipped (so a fixture can be visually grouped); every remaining line MUST be a
/// JSON object carrying a string `type`, or the parse panics — a silently-dropped
/// line would let a broken fixture "pass" by replaying nothing.
pub(super) fn parse_transcript(raw: &str) -> Vec<Value> {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let event: Value = serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("transcript line is not valid JSON ({e}): {line}"));
            assert!(
                event.get("type").and_then(Value::as_str).is_some(),
                "every transcript event must carry a string `type`: {line}"
            );
            event
        })
        .collect()
}

/// The three checked-in transcripts, so the integrity test below covers every
/// fixture the drivers replay (a new fixture line that doesn't parse fails HERE,
/// independent of whichever driver consumes it).
const BUILD: &str = include_str!("fixtures/build.jsonl");
const INSIGHT_SCAN: &str = include_str!("fixtures/insight-scan.jsonl");
const PR_REVIEW: &str = include_str!("fixtures/pr-review.jsonl");

#[test]
fn fixtures_are_wire_shaped() {
    // Every fixture parses to a non-empty, wire-`type`-tagged event stream. This is
    // the grounding guard: a malformed line (or an accidental prose line) fails loudly
    // instead of replaying an empty transcript that trivially "passes".
    for (name, raw) in [
        ("build", BUILD),
        ("insight-scan", INSIGHT_SCAN),
        ("pr-review", PR_REVIEW),
    ] {
        let events = parse_transcript(raw);
        assert!(!events.is_empty(), "{name} fixture has no events");
        // The first event of every transcript is its family's `*-started`/ready opener,
        // and the last is a terminal — the two ends the reader keys correlation and
        // finalization on.
        let first = events.first().unwrap()["type"].as_str().unwrap();
        let last = events.last().unwrap()["type"].as_str().unwrap();
        assert!(
            first.ends_with("-started") || first.ends_with("-ready"),
            "{name} opens on {first:?}, expected a started/ready event"
        );
        assert!(
            last.ends_with("-completed") || last.ends_with("-failed"),
            "{name} ends on {last:?}, expected a terminal event"
        );
    }
}
