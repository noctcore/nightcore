//! Failing-CI-check discovery for the `ci` fix kind: one bounded `gh pr checks
//! --json` read, filtered to the failing bucket. The check names / workflow
//! names / summaries come from the target repo's CI configuration — REPO-
//! CONTROLLED text, so the prompt builder fences every one of them
//! (`untrusted_block`), exactly like review-finding text.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::workflow::pr::{map_gh_failure, probe_gh, run_gh_bounded};

/// Wall-clock bound on the `gh pr checks` read (a single-PR check listing moves
/// no data — the `GH_VIEW_TIMEOUT` rationale).
pub(super) const GH_CHECKS_TIMEOUT: Duration = Duration::from_secs(60);

/// One failing check, as the prompt builder consumes it. Every string field is
/// repo-controlled (CI job names, workflow names, failure summaries) and is
/// fenced before it reaches the session prompt.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct FailingCheck {
    pub(super) name: String,
    pub(super) workflow: String,
    pub(super) description: String,
}

/// Read the PR's FAILING checks via bounded `gh pr checks --json`. Binary-
/// parameterized — the fake-`gh` test seam (the PR-arc fixture pattern).
///
/// Exit-code note: `gh pr checks` deliberately exits non-zero when checks are
/// failing (1) or pending (8) — the very states this command exists to read —
/// so the outcome mapping is parse-first: a parseable JSON body wins regardless
/// of exit code, and only an unparseable body on a non-zero exit surfaces as a
/// `gh` failure.
pub(super) fn fetch_failing_checks_with(
    dir: &Path,
    binary: &str,
    pr_number: u64,
    deadline: Duration,
) -> Result<Vec<FailingCheck>, String> {
    probe_gh(binary, "install it to read the PR's CI checks")?;
    let number_arg = pr_number.to_string();
    let out = run_gh_bounded(
        dir,
        binary,
        &[
            "pr",
            "checks",
            &number_arg,
            "--json",
            "bucket,name,workflow,description",
        ],
        None,
        deadline,
        "timed out reading the PR's checks from GitHub — check your network and try again",
    )?;
    match parse_failing_checks(&out.stdout) {
        Ok(checks) => Ok(checks),
        Err(parse_err) => {
            if out.status.success() {
                Err(parse_err)
            } else {
                Err(map_gh_failure(binary, "pr checks", &out))
            }
        }
    }
}

/// Parse the `gh pr checks --json bucket,name,workflow,description` body down
/// to the failing bucket. Pure — unit-tested. Unknown buckets are ignored
/// (pass/pending/skipping/cancel vocabularies drift); only `fail` is a target.
pub(super) fn parse_failing_checks(stdout: &str) -> Result<Vec<FailingCheck>, String> {
    #[derive(Deserialize)]
    struct CheckRow {
        bucket: String,
        name: String,
        #[serde(default)]
        workflow: String,
        #[serde(default)]
        description: String,
    }
    let rows: Vec<CheckRow> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("`gh pr checks` returned unparseable JSON: {e}"))?;
    Ok(rows
        .into_iter()
        .filter(|r| r.bucket == "fail")
        .map(|r| FailingCheck {
            name: r.name,
            workflow: r.workflow,
            description: r.description,
        })
        .collect())
}
