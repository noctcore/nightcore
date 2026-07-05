//! The diff-fetch seam: resolve a PR's `gh pr diff <n>` output (capped) + its
//! changed-file set, both bounded, so `start_pr_review` (the sidecar bridge) can
//! pass the diff inline on the start command. Called on the blocking pool (it
//! talks to GitHub).

use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use super::GH_TIMEOUT;
use crate::git::gh::{run_gh_checked, run_gh_json, GhCall, GH_BINARY};

/// Cap on the resolved PR diff handed to the sidecar (512 KiB). A gargantuan diff would
/// blow the review prompt's context budget; past the cap we truncate + append a marker
/// so the model reviews the leading slice and knows the tail was elided.
pub(crate) const PR_DIFF_CAP: usize = 512 * 1024;

/// Truncate `diff` to at most `cap` bytes at a UTF-8 char boundary, appending a marker
/// when it overflows. Pure, unit-testable.
pub(super) fn cap_diff(mut diff: String, cap: usize) -> String {
    if diff.len() <= cap {
        return diff;
    }
    let mut end = cap;
    while end > 0 && !diff.is_char_boundary(end) {
        end -= 1;
    }
    diff.truncate(end);
    diff.push_str(&format!("\n[diff truncated at {cap} bytes]"));
    diff
}

/// Resolve a PR's diff + changed-file set for the sidecar (production entry point):
/// `gh pr diff <n>` (capped) and `gh pr diff <n> --name-only`, both bounded, in `dir`.
/// `pub(crate)` so the sidecar's `start_pr_review` can call it off the UI thread.
pub(crate) fn fetch_pr_diff(dir: &Path, pr_number: u64) -> Result<(String, Vec<String>), String> {
    fetch_pr_diff_with(dir, GH_BINARY, pr_number, GH_TIMEOUT)
}

/// Binary-parameterized diff fetch — the injection seam the tests exercise with a fake
/// `gh` script (the phase-1/3 template). Resolves `gh pr diff <n>` (capped at
/// [`PR_DIFF_CAP`]) then `gh pr diff <n> --name-only`. `pr_number` is a `u64` rendered
/// decimal (injection-safe — it can never be an option token).
pub(super) fn fetch_pr_diff_with(
    dir: &Path,
    binary: &str,
    pr_number: u64,
    deadline: Duration,
) -> Result<(String, Vec<String>), String> {
    if pr_number == 0 {
        return Err("enter a valid PR number (a positive integer)".to_string());
    }
    let number = pr_number.to_string();

    let diff_stdout = run_gh_checked(GhCall {
        dir,
        binary,
        args: &["pr", "diff", &number],
        action: "install it to review pull requests",
        subcmd: "pr diff",
        stdin: None,
        deadline,
        timeout_msg: "timed out fetching the PR diff from GitHub — check your network and try again",
    })?;
    let diff = cap_diff(diff_stdout, PR_DIFF_CAP);

    let names_stdout = run_gh_checked(GhCall {
        dir,
        binary,
        args: &["pr", "diff", &number, "--name-only"],
        action: "install it to review pull requests",
        subcmd: "pr diff --name-only",
        stdin: None,
        deadline,
        timeout_msg:
            "timed out fetching the PR changed files from GitHub — check your network and try again",
    })?;
    let changed_files: Vec<String> = names_stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();

    Ok((diff, changed_files))
}

/// Resolve a PR's head commit SHA (`gh pr view <n> --json headRefOid`) so a PR-review
/// run can be stamped with the head it reviewed — the UI then flags the run STALE once
/// the PR advances past it. `pub(crate)` production entry point; called BEST-EFFORT off
/// the UI thread (a failure here must not fail an already-fetched review).
pub(crate) fn fetch_pr_head_oid(dir: &Path, pr_number: u64) -> Result<String, String> {
    fetch_pr_head_oid_with(dir, GH_BINARY, pr_number, GH_TIMEOUT)
}

/// Binary-parameterized head-oid fetch — the fake-`gh` injection seam. `gh pr view <n>
/// --json headRefOid` prints `{"headRefOid":"<sha>"}`; an absent field degrades to an
/// empty string (the caller treats empty as "no marker"). `pr_number` is a `u64`
/// rendered decimal (injection-safe).
pub(super) fn fetch_pr_head_oid_with(
    dir: &Path,
    binary: &str,
    pr_number: u64,
    deadline: Duration,
) -> Result<String, String> {
    if pr_number == 0 {
        return Err("enter a valid PR number (a positive integer)".to_string());
    }
    let number = pr_number.to_string();
    let value: Value = run_gh_json(GhCall {
        dir,
        binary,
        args: &["pr", "view", &number, "--json", "headRefOid"],
        action: "install it to review pull requests",
        subcmd: "pr view",
        stdin: None,
        deadline,
        timeout_msg: "timed out reading the PR head from GitHub — check your network and try again",
    })?;
    Ok(value
        .get("headRefOid")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}
