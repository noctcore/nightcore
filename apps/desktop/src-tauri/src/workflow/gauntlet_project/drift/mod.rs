//! EnforceRun — run the armed checks AND measure convention DRIFT (T15 + #279).
//!
//! The Enforce stage ships coverage ("is there a rule?"), not conformance ("is it
//! FOLLOWED at every site?"). This is the conformance leg: an EnforceRun runs the
//! human-ARMED checks and, for each compiled DRIFT check (a substrate carrying a
//! `conventionFingerprint`), turns its output into per-site counts and a
//! `ConventionDrift` record joined back to the convention.
//!
//! Split by responsibility:
//!   - [`run`] sequences the armed manifest and routes each check to a gate or a
//!     measurement (`run_with_drift`, the crate-facing entry point);
//!   - [`record`] builds the `ConventionDrift` records — the ONLY place a count-less
//!     record can be constructed, and it always yields `errored`;
//!   - [`capture`] is the bounded subprocess capture + JSON slicing both substrates use;
//!   - [`lint_meta`] is the substrate Nightcore OWNS, measured end to end through the
//!     machine-readable `--json` reporter's per-rule counts;
//!   - [`eslint`] (Drift-v2, #279) is a GENERATED ESLint rule, measured through the
//!     target repo's own ESLint with `--format json --stats`.
//!
//! **shell** is ARMABLE + shape-validated (`super::command_guard`) but its execution /
//! counting is a fast-follow (issue #187): [`super::config::plan_check`] skips shell
//! checks, so this pass never sees one. When shell execution lands it plugs in beside
//! the other two arms in `run::measure_drift_check`.
//!
//! Non-negotiable product rule: NEVER emit `clean`/`drifted` without a `method` + real
//! counts. A check whose output can't be turned into confident counts is `errored`
//! (fail-visible), never silently `clean`.
//!
//! Drift is emitted ONLY for armed checks that carry a `conventionFingerprint` (an
//! EnforceRun is project-scoped and reads only the manifest — it has no access to the
//! scan's full convention set, so the UI derives `uncheckable` for conventions with no
//! armed check).

mod capture;
mod eslint;
mod lint_meta;
mod record;
mod run;

pub(crate) use run::run_with_drift;

/// Shared fixtures for the substrate leaves' end-to-end tests: a temp repo whose armed
/// check is a script echoing a canned machine-readable report, so the whole EnforceRun
/// wiring (load → run → capture → parse → join) runs without needing the real toolchain.
#[cfg(test)]
pub(super) mod test_support {
    /// The convention fingerprint every drift fixture joins on.
    pub(crate) const FP: &str = "a1b2c3d4e5f60718";

    #[cfg(unix)]
    pub(crate) fn fixture_repo(report_body: &str) -> tempfile::TempDir {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = tmp.path().join("report.sh");
        std::fs::write(
            &script,
            format!("#!/bin/sh\ncat <<'EOF'\n{report_body}\nEOF\n"),
        )
        .expect("write script");
        let mut perms = std::fs::metadata(&script).expect("meta").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).expect("chmod");
        let nc = tmp.path().join(".nightcore");
        std::fs::create_dir_all(&nc).expect("mkdir .nightcore");
        std::fs::write(nc.join("harness.json"), "PLACEHOLDER").expect("write manifest");
        tmp
    }
}
