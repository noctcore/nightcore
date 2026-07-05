//! Fetch a linked PR's diff (`gh pr diff <n>`, capped) so `start_issue_validation`
//! can inject it as UNTRUSTED context on the start command — the read-only validation
//! session never shells out. Best-effort: a PR whose diff can't be fetched simply
//! carries no diff (the analysis still runs on the issue text).

use std::path::Path;
use std::time::Duration;

use super::{cap_text, ISSUE_PR_DIFF_MAX_LEN};
use crate::workflow::pr::{probe_gh, run_gh_bounded, GH_BINARY};

/// Production entry point: fetch PR `pr_number`'s capped diff in `dir`, or `None` on
/// any failure (missing `gh`, network timeout, non-zero exit). BEST-EFFORT by design —
/// the caller injects the diff only when present.
pub(crate) fn fetch_linked_pr_diff(dir: &Path, pr_number: u64) -> Option<String> {
    fetch_linked_pr_diff_with(dir, GH_BINARY, pr_number, super::GH_TIMEOUT)
}

/// Binary-parameterized diff fetch — the fake-`gh` injection seam. `pr_number` is a
/// `u64` rendered decimal (injection-safe). Returns the diff capped at
/// [`ISSUE_PR_DIFF_MAX_LEN`], or `None` on any failure (best-effort).
pub(super) fn fetch_linked_pr_diff_with(
    dir: &Path,
    binary: &str,
    pr_number: u64,
    deadline: Duration,
) -> Option<String> {
    if pr_number == 0 {
        return None;
    }
    probe_gh(binary, "install it to read linked PRs").ok()?;
    let number = pr_number.to_string();
    let out = run_gh_bounded(
        dir,
        binary,
        &["pr", "diff", &number],
        None,
        deadline,
        "timed out fetching the linked PR diff from GitHub",
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let diff = out.stdout;
    if diff.trim().is_empty() {
        return None;
    }
    Some(cap_text(diff, ISSUE_PR_DIFF_MAX_LEN))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_number_zero_yields_none_without_spawning() {
        assert!(
            fetch_linked_pr_diff_with(Path::new("/tmp"), "gh", 0, Duration::from_secs(1)).is_none()
        );
    }
}
