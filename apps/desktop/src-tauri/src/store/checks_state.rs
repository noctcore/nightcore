//! Persistence of the last ON-DEMAND armed-checks run (Checks Manager, T7).
//!
//! The armed-checks gauntlet already runs during task verification (its result is
//! stored per-task on `Task.structure_lock_result`). The Enforce panel's "Run
//! armed checks now" is a project-scoped, task-less run — so its result lives in a
//! tiny project-local file, `<project>/.nightcore/checks-last-run.json`, and the
//! panel reads it back on mount to show each check's LAST result (and the run-level
//! pass/fail + timestamp) without re-running. `.nightcore/` is gitignored, so this
//! is transient local state, never committed.
//!
//! Lenient read (absent/malformed ⇒ `None`, mirroring the policy reader), atomic
//! write (temp + rename), server-resolved path (the active project) — the exact
//! posture of the other single-file stores.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::store::types::{ConventionDrift, StructureLockResult};

/// The project-relative path of the last on-demand run record.
const LAST_RUN_REL_PATH: &str = ".nightcore/checks-last-run.json";

fn last_run_file(project_path: &str) -> PathBuf {
    Path::new(project_path).join(LAST_RUN_REL_PATH)
}

/// The persisted last on-demand run: the full gauntlet result plus when it ran
/// (ms since epoch). Serde-only (internal transient state, not a ts-rs boundary
/// type); the command layer projects it into the web-facing `ArmedChecksState`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StoredArmedChecksRun {
    pub(crate) ran_at: u64,
    pub(crate) result: StructureLockResult,
    /// Drift-v1 (T15): per-convention drift measured by this EnforceRun (one record
    /// per armed compiled check that carries a `conventionFingerprint`). Additive:
    /// `#[serde(default)]` so a pre-drift last-run record loads with an empty vec.
    #[serde(default)]
    pub(crate) drift: Vec<ConventionDrift>,
    /// Whether this EnforceRun included the opt-in DEEP conformance audit. Persisted
    /// so a run's depth stays recoverable after the fact — the Insight family learned
    /// that the hard way (a run whose depth was unknown can never be compared, see
    /// `InsightRun.deep`). Additive: an older record loads as `false`.
    #[serde(default)]
    pub(crate) deep: bool,
    /// Carry-forward (#279): the most recent EARLIER run that actually MEASURED
    /// something, kept so the panel can show a run-over-run drift delta. Exactly one
    /// slot by construction ([`PriorArmedChecksRun`] cannot itself nest), and it holds
    /// only what a delta needs — never the whole gauntlet result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) previous: Option<Box<PriorArmedChecksRun>>,
}

/// The carried-forward predecessor of the last run: when it ran, at what depth, and
/// the drift it measured. Deliberately NOT a [`StoredArmedChecksRun`] — a distinct
/// type makes the "exactly two generations" invariant structural rather than a
/// convention someone can break by forgetting to clear a nested field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PriorArmedChecksRun {
    pub(crate) ran_at: u64,
    #[serde(default)]
    pub(crate) drift: Vec<ConventionDrift>,
    #[serde(default)]
    pub(crate) deep: bool,
}

/// Persist the last on-demand run for `project_path`, rotating the previous one into
/// the carry-forward slot. Best-effort atomic write; creates `.nightcore/` when absent.
///
/// **Rotation rule:** the outgoing run becomes `previous` only when it MEASURED
/// something (≥1 drift record). A run that measured nothing cannot anchor a delta, so
/// letting it evict a usable predecessor would silently destroy the comparison — the
/// existing `previous` is kept instead. This is the single-slot form of the rule
/// Insight's delta implements by scanning back to the most recent comparable run; the
/// panel always renders the predecessor's timestamp so "compared against" is never
/// implied to be "the run just before this one".
pub(crate) fn write_last_run(
    project_path: &str,
    result: &StructureLockResult,
    drift: &[ConventionDrift],
    ran_at: u64,
) -> Result<(), String> {
    let path = last_run_file(project_path);
    let previous = carry_forward(read_last_run(project_path));
    let stored = StoredArmedChecksRun {
        ran_at,
        result: result.clone(),
        drift: drift.to_vec(),
        deep: false,
        previous,
    };
    let json = serde_json::to_string_pretty(&stored)
        .map_err(|e| format!("failed to serialize checks-last-run: {e}"))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    crate::store::write_atomic(&path, json.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Pick the carry-forward slot for the NEXT write, given the record on disk.
/// See [`write_last_run`]'s rotation rule.
fn carry_forward(existing: Option<StoredArmedChecksRun>) -> Option<Box<PriorArmedChecksRun>> {
    let existing = existing?;
    if existing.drift.is_empty() {
        // Measured nothing ⇒ it cannot anchor a delta; keep whatever it was carrying.
        return existing.previous;
    }
    Some(Box::new(PriorArmedChecksRun {
        ran_at: existing.ran_at,
        drift: existing.drift,
        deep: existing.deep,
    }))
}

/// Read the last on-demand run for `project_path`. Lenient: an absent or malformed
/// record yields `None` (the panel simply shows "not run yet"), never an error.
pub(crate) fn read_last_run(project_path: &str) -> Option<StoredArmedChecksRun> {
    let raw = std::fs::read_to_string(last_run_file(project_path)).ok()?;
    match serde_json::from_str(&raw) {
        Ok(run) => Some(run),
        Err(e) => {
            tracing::warn!(
                target: "nightcore::checks_manager",
                error = %e,
                "malformed .nightcore/checks-last-run.json; ignoring the last-run record"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::types::{StepStatus, StructureLockCheck};

    fn root_of(tmp: &tempfile::TempDir) -> String {
        tmp.path().to_string_lossy().to_string()
    }

    fn sample_result() -> StructureLockResult {
        StructureLockResult {
            passed: false,
            failed_check: Some("lint".into()),
            checks: vec![StructureLockCheck {
                name: "lint".into(),
                kind: "lint-plugin".into(),
                command: "npx eslint .".into(),
                status: StepStatus::Failed,
                exit_code: Some(1),
                output: Some("boom".into()),
                duration_ms: Some(1200),
            }],
        }
    }

    fn sample_drift() -> ConventionDrift {
        drift_with("abc123", "drifted", 3)
    }

    fn drift_with(fp: &str, status: &str, matched: u64) -> ConventionDrift {
        ConventionDrift {
            id: format!("drift-{fp}"),
            convention_fingerprint: fp.into(),
            category: String::new(),
            title: "folder-per-component".into(),
            status: status.into(),
            method: "lint-meta: folder-per-component".into(),
            sites_matched: matched,
            sites_checked: matched.max(1),
            check_name: Some("folder-per-component".into()),
            error_reason: None,
            fingerprint: fp.into(),
        }
    }

    #[test]
    fn write_then_read_round_trips() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        assert!(read_last_run(&root_of(&tmp)).is_none(), "absent ⇒ None");
        write_last_run(
            &root_of(&tmp),
            &sample_result(),
            &[sample_drift()],
            1_700_000_000_000,
        )
        .expect("write");
        let run = read_last_run(&root_of(&tmp)).expect("present");
        assert_eq!(run.ran_at, 1_700_000_000_000);
        assert!(!run.result.passed);
        assert_eq!(run.result.checks[0].name, "lint");
        assert_eq!(run.result.checks[0].duration_ms, Some(1200));
        // Drift persists additively alongside the gauntlet result.
        assert_eq!(run.drift.len(), 1);
        assert_eq!(run.drift[0].status, "drifted");
        assert_eq!(run.drift[0].sites_matched, 3);
    }

    #[test]
    fn a_pre_drift_record_loads_with_an_empty_drift_vec() {
        // Additive `#[serde(default)]`: a last-run record written before drift existed
        // (no `drift` key) must still load, with drift defaulting to empty.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let nc = tmp.path().join(".nightcore");
        std::fs::create_dir_all(&nc).expect("mkdir");
        std::fs::write(
            nc.join("checks-last-run.json"),
            r#"{ "ran_at": 1, "result": { "passed": true, "checks": [] } }"#,
        )
        .expect("write");
        let run = read_last_run(&root_of(&tmp)).expect("present");
        assert!(run.drift.is_empty());
        assert!(!run.deep, "an older record loads at the shallow default");
        assert!(run.previous.is_none());
    }

    /// Carry-forward (#279): a second run rotates the first into `previous`, keeping
    /// exactly two generations.
    #[test]
    fn a_second_run_carries_the_first_forward() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let root = root_of(&tmp);

        write_last_run(
            &root,
            &sample_result(),
            &[drift_with("fp", "drifted", 3)],
            1,
        )
        .expect("write 1");
        write_last_run(&root, &sample_result(), &[drift_with("fp", "clean", 0)], 2)
            .expect("write 2");

        let run = read_last_run(&root).expect("present");
        assert_eq!(run.ran_at, 2);
        assert_eq!(run.drift[0].sites_matched, 0);
        let prev = run.previous.as_ref().expect("carried forward");
        assert_eq!(prev.ran_at, 1);
        assert_eq!(prev.drift[0].sites_matched, 3);
        assert!(!prev.deep);

        // A THIRD run keeps exactly two generations — the first is gone, not nested.
        write_last_run(&root, &sample_result(), &[drift_with("fp", "clean", 1)], 3)
            .expect("write 3");
        let run = read_last_run(&root).expect("present");
        assert_eq!(run.previous.as_ref().expect("prev").ran_at, 2);
        let raw = std::fs::read_to_string(tmp.path().join(".nightcore/checks-last-run.json"))
            .expect("read raw");
        assert_eq!(
            raw.matches("\"previous\"").count(),
            1,
            "the carry-forward slot never nests"
        );
    }

    /// A run that measured NOTHING must not evict a usable predecessor — otherwise a
    /// single no-op run silently destroys the comparison.
    #[test]
    fn a_run_that_measured_nothing_does_not_evict_the_predecessor() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let root = root_of(&tmp);

        write_last_run(
            &root,
            &sample_result(),
            &[drift_with("fp", "drifted", 5)],
            1,
        )
        .expect("write 1");
        write_last_run(&root, &sample_result(), &[drift_with("fp", "clean", 0)], 2)
            .expect("write 2");
        // Run 3 measures nothing (e.g. every drift check was disarmed).
        write_last_run(&root, &sample_result(), &[], 3).expect("write 3");

        let run = read_last_run(&root).expect("present");
        assert!(run.drift.is_empty());
        let prev = run.previous.as_ref().expect("predecessor survives");
        assert_eq!(prev.ran_at, 2, "kept the last run that actually measured");
    }

    /// The first ever run has nothing to carry forward.
    #[test]
    fn the_first_run_carries_nothing_forward() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        write_last_run(&root_of(&tmp), &sample_result(), &[sample_drift()], 1).expect("write");
        assert!(read_last_run(&root_of(&tmp))
            .expect("present")
            .previous
            .is_none());
    }

    #[test]
    fn malformed_record_reads_as_none() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let nc = tmp.path().join(".nightcore");
        std::fs::create_dir_all(&nc).expect("mkdir");
        std::fs::write(nc.join("checks-last-run.json"), "{ not json").expect("write");
        assert!(read_last_run(&root_of(&tmp)).is_none(), "malformed ⇒ None");
    }
}
