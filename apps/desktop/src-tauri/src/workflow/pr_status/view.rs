//! The read substrate shared by all four PR-status commands: the [`PrStatus`]
//! wire contract, the tolerant `gh pr view` deserialization ([`GhPrView`]) + the
//! status-check rollup classifier, the bounded `gh pr view` seam
//! ([`fetch_pr_view_with`]), and the [`require_pr_number`] precondition. Pure
//! parsing + one injectable `gh` spawn; no leases, no state mutation.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
// ts-rs is a dev-dependency (the Rust→TS codegen runs under `cargo test` only).
#[cfg(test)]
use ts_rs::TS;

use crate::git::gh::{run_gh_json, GhCall, PR_VIEW_FIELDS};
use crate::task::Task;

/// Wall-clock bound on the read-only `gh pr view` spawns (status + the finalize
/// re-verification). Tighter than the create/push bound — a view moves no data,
/// so a black-holed GitHub should fail the refresh fast, not pin a blocking
/// thread for two minutes.
pub(super) const GH_VIEW_TIMEOUT: Duration = Duration::from_secs(60);

/// A point-in-time snapshot of a task's GitHub PR for the status card. All
/// GitHub-vocabulary fields are plain strings passed through from `gh` (NO enum
/// fork — the UI degrades gracefully on values a newer GitHub introduces).
/// Deliberately carries NO timestamps: the web stamps receive-time locally.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrStatus.ts"))]
pub struct PrStatus {
    /// PR lifecycle state: `OPEN` | `CLOSED` | `MERGED` (gh vocabulary).
    pub state: String,
    /// Whether the PR is still a draft.
    pub is_draft: bool,
    /// Content mergeability: `MERGEABLE` | `CONFLICTING` | `UNKNOWN`.
    pub mergeable: String,
    /// Merge-box state: `CLEAN` | `BEHIND` | `BLOCKED` | `DIRTY` | `UNSTABLE` | ….
    pub merge_state_status: String,
    /// Review decision: `APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED`,
    /// or empty when the base branch requires no review.
    pub review_decision: String,
    /// Checks counted Rust-side from `statusCheckRollup` (see [`count_checks`]).
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_pending: u32,
    /// The PR's base branch on GitHub.
    pub base_ref_name: String,
    /// The PR head commit SHA (`headRefOid`), empty when gh omits it. Lets the UI
    /// detect a PR-review run gone STALE — the PR advanced past the head it reviewed.
    pub head_ref_oid: String,
    /// The gh-reported PR page URL (never the raw git remote URL, which can
    /// embed credentials and must not cross the IPC boundary).
    pub url: String,
    pub number: u64,
    /// LOCAL-only: commits on the task branch not on its upstream — computed
    /// from the worktree with no network. `Some(0)` also covers a removed
    /// worktree (nothing local exists to push). `None` = CANNOT DETERMINE: the
    /// branch's `@{upstream}` doesn't resolve (e.g. pruned after GitHub
    /// auto-deleted the merged head branch) — the UI must NOT read that as "all
    /// pushed"; a re-push with `-u` recreates the upstream.
    pub unpushed_commits: Option<u32>,
}

/// The deserialized shape of `gh pr view --json` output. Everything beyond the
/// identifying trio (`number`/`url`/`state`) is optional with a safe default,
/// so vocabulary/field drift across gh versions degrades a field — never the
/// whole snapshot.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GhPrView {
    pub(super) number: u64,
    pub(super) url: String,
    pub(super) state: String,
    #[serde(default)]
    pub(super) is_draft: Option<bool>,
    #[serde(default)]
    pub(super) mergeable: Option<String>,
    #[serde(default)]
    pub(super) merge_state_status: Option<String>,
    #[serde(default)]
    pub(super) review_decision: Option<String>,
    #[serde(default)]
    pub(super) base_ref_name: Option<String>,
    #[serde(default)]
    pub(super) head_ref_oid: Option<String>,
    /// Kept as raw JSON: the entries come in TWO shapes (CheckRun vs
    /// StatusContext) whose fields drift across gh versions — [`count_checks`]
    /// classifies them tolerantly instead of a strict deserialization.
    #[serde(default)]
    pub(super) status_check_rollup: Option<serde_json::Value>,
}

impl GhPrView {
    /// Map the gh view onto the wire contract, folding the rollup into counts
    /// and attaching the locally-computed unpushed count (`None` = the upstream
    /// was unresolvable, so the count is unknown).
    pub(super) fn into_status(self, unpushed_commits: Option<u32>) -> PrStatus {
        let (checks_passed, checks_failed, checks_pending) =
            count_checks(self.status_check_rollup.as_ref());
        PrStatus {
            state: self.state,
            is_draft: self.is_draft.unwrap_or(false),
            mergeable: self.mergeable.unwrap_or_default(),
            merge_state_status: self.merge_state_status.unwrap_or_default(),
            review_decision: self.review_decision.unwrap_or_default(),
            checks_passed,
            checks_failed,
            checks_pending,
            base_ref_name: self.base_ref_name.unwrap_or_default(),
            head_ref_oid: self.head_ref_oid.unwrap_or_default(),
            url: self.url,
            number: self.number,
            unpushed_commits,
        }
    }
}

/// One rollup entry's verdict (see [`classify_check`]).
enum CheckClass {
    Passed,
    Failed,
    Pending,
}

/// Count a `statusCheckRollup` array into `(passed, failed, pending)`. A null,
/// absent, or non-array rollup counts as all zeros (a PR with no checks).
pub(super) fn count_checks(rollup: Option<&serde_json::Value>) -> (u32, u32, u32) {
    let Some(serde_json::Value::Array(items)) = rollup else {
        return (0, 0, 0);
    };
    let (mut passed, mut failed, mut pending) = (0u32, 0u32, 0u32);
    for item in items {
        match classify_check(item) {
            CheckClass::Passed => passed += 1,
            CheckClass::Failed => failed += 1,
            CheckClass::Pending => pending += 1,
        }
    }
    (passed, failed, pending)
}

/// Classify one rollup entry. The entries come in TWO shapes — a CheckRun
/// (`status` + `conclusion`) and a StatusContext (`state`) — and the vocabulary
/// drifts across gh/GitHub versions, so the mapping is deliberately tolerant:
/// only the enumerated pass/fail values count as such; EVERYTHING else
/// (unfinished runs, unknown strings, malformed entries) is *pending*, the
/// verdict that never overstates a green or a red. Matching is
/// case-insensitive (defence against casing drift).
fn classify_check(item: &serde_json::Value) -> CheckClass {
    let field = |key: &str| {
        item.get(key)
            .and_then(|v| v.as_str())
            .map(|v| v.to_ascii_uppercase())
    };
    // StatusContext shape: a `state` field.
    if let Some(state) = field("state") {
        return match state.as_str() {
            "SUCCESS" => CheckClass::Passed,
            "FAILURE" | "ERROR" => CheckClass::Failed,
            // PENDING / EXPECTED / anything a newer GitHub invents.
            _ => CheckClass::Pending,
        };
    }
    // CheckRun shape: a run that hasn't COMPLETED has no verdict yet, whatever
    // its conclusion field says.
    if let Some(status) = field("status") {
        if status != "COMPLETED" {
            return CheckClass::Pending; // QUEUED / IN_PROGRESS / WAITING / …
        }
    }
    match field("conclusion").as_deref() {
        Some("SUCCESS") | Some("NEUTRAL") | Some("SKIPPED") => CheckClass::Passed,
        Some("FAILURE")
        | Some("CANCELLED")
        | Some("TIMED_OUT")
        | Some("ACTION_REQUIRED")
        | Some("STARTUP_FAILURE") => CheckClass::Failed,
        // No conclusion, an unknown conclusion, or a malformed entry.
        _ => CheckClass::Pending,
    }
}

/// Run `gh pr view <number> --json …` in `dir` (bounded by `deadline`) and
/// deserialize it. Binary-parameterized — the injection seam the tests use to
/// exercise the real spawn path with a fake script (the phase-1 template).
pub(super) fn fetch_pr_view_with(
    dir: &Path,
    binary: &str,
    number: u64,
    deadline: Duration,
) -> Result<GhPrView, String> {
    let number_arg = number.to_string();
    run_gh_json(GhCall {
        dir,
        binary,
        args: &["pr", "view", &number_arg, "--json", PR_VIEW_FIELDS],
        action: "install it to track pull requests",
        subcmd: "pr view",
        stdin: None,
        deadline,
        timeout_msg:
            "timed out reading the pull request from GitHub — check your network and try again",
    })
}

/// The task's recorded PR number, or a clear refusal — the shared precondition
/// of the status read and the finalize. Pure.
pub(super) fn require_pr_number(task: &Task) -> Result<u64, String> {
    task.pr_number
        .ok_or_else(|| "no PR is recorded for this task — create one first".to_string())
}
