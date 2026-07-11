//! The `nc:*` status-label vocabulary + the two idempotent `gh api` REST primitives that
//! ATTACH/DETACH it on an issue (§3.1 / §3.3).
//!
//! The label-DEFINITION ensure (`POST …/labels`) is NOT here: it lives in the shared
//! [`crate::workflow::github_labels::ensure_label_named`] seam that both this writeback
//! and the scan-map export route through (#97 decision 5) — one create path + one
//! ensure-cache, never a forked parallel seam.
//!
//! Every mutation clones the injection-safe posture of `post_issue_comment_with`
//! (`workflow/issue_triage/post.rs`): `gh api` REST, a decimal `u64` issue number in the
//! path, controlled label names (our own `nc:*` constants — never attacker text), each
//! run bounded by a deadline via [`run_gh_bounded`] (which applies the git-env scrub).
//! The primitives are binary-parameterized (`_with`) so the tests inject a fake `gh`
//! script instead of shelling to the real one — no live GitHub traffic.
//!
//! Idempotency (the anti-churn heart of decision 1): `add_label` is ADDITIVE
//! (`POST …/labels` with `labels[]=`, never the `PUT` replace that would nuke the user's
//! other labels); `remove_label` tolerates a 404 (already absent) as success. A label
//! SWITCH is `ensure(desired)` → `add(desired)` → `remove(prev)` — no read/list call,
//! because `prev` is the task's `issue_synced_label`.

use std::path::Path;
use std::time::Duration;

use crate::git::gh::{map_gh_failure, probe_gh, run_gh_bounded, GhOutput};

/// Deadline for one label REST call — a tiny add/remove/create, not a GraphQL list, so a
/// stuck one releases the per-root mutation lease promptly rather than pinning it for the
/// triage GraphQL timeout (90s).
pub(super) const GH_LABEL_TIMEOUT: Duration = Duration::from_secs(30);

/// The install-hint action `probe_gh` names when `gh` is missing (shared by both
/// attach/detach primitives — they both sync issue labels).
const PROBE_ACTION: &str = "install it to sync issue labels";

/// One managed `nc:*` status label: its stable SUFFIX (prefix-independent, so a project
/// can remap the `nc:` prefix without changing these), plus the fixed color +
/// description that make the shared
/// [`crate::workflow::github_labels::ensure_label_named`] idempotent (we never rewrite an
/// existing label's color, so a create is the only label-definition write we ever make).
pub(super) struct LabelSpec {
    pub(super) suffix: &'static str,
    pub(super) color: &'static str,
    pub(super) description: &'static str,
}

/// The 5-label vocabulary (§3.1). The 7 `TaskStatus` variants collapse into these 5 so
/// ordinary lifecycle churn (Backlog↔Ready, InProgress↔Verifying) does NOT re-label.
pub(super) const LABEL_SPECS: [LabelSpec; 5] = [
    LabelSpec {
        suffix: "queued",
        color: "cccccc",
        description: "Queued in Nightcore",
    },
    LabelSpec {
        suffix: "in-progress",
        color: "1d76db",
        description: "Being worked by a Nightcore agent",
    },
    LabelSpec {
        suffix: "review",
        color: "fbca04",
        description: "Awaiting human review/approval in Nightcore",
    },
    LabelSpec {
        suffix: "done",
        color: "0e8a16",
        description: "Completed in Nightcore (not yet merged)",
    },
    LabelSpec {
        suffix: "failed",
        color: "d73a4a",
        description: "Failed in Nightcore",
    },
];

/// The [`LabelSpec`] for a vocabulary suffix (`"queued"` → its color/description), for the
/// `ensure` step of a label transition. `None` for an unknown suffix (never happens for
/// our own [`super::transition::desired_label`] output).
pub(super) fn spec_for(suffix: &str) -> Option<&'static LabelSpec> {
    LABEL_SPECS.iter().find(|s| s.suffix == suffix)
}

/// Compose the full label name from the configured prefix + a vocabulary suffix
/// (`"nc:"` + `"in-progress"` → `"nc:in-progress"`).
pub(super) fn full_name(prefix: &str, suffix: &str) -> String {
    format!("{prefix}{suffix}")
}

/// The HTTP status `gh api` reports on a failed call. `gh` prints `gh: <message> (HTTP
/// <code>)` to stderr; a few paths carry the status only in the JSON error body on stdout.
/// Best-effort — `None` when neither is parseable.
fn http_status(out: &GhOutput) -> Option<u16> {
    for hay in [out.stderr.as_str(), out.stdout.as_str()] {
        if let Some(idx) = hay.find("HTTP ") {
            let digits: String = hay[idx + 5..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if let Ok(code) = digits.parse::<u16>() {
                return Some(code);
            }
        }
    }
    None
}

/// ADDITIVELY attach `name` to the issue (`POST …/issues/{n}/labels` with `labels[]=`).
/// Never touches the user's other labels (unlike a `PUT …/labels` replace). `issue_number`
/// is a `u64` rendered decimal (injection-safe); a zero is rejected before spawn.
pub(super) fn add_label_with(
    dir: &Path,
    binary: &str,
    issue_number: u64,
    name: &str,
    deadline: Duration,
) -> Result<(), String> {
    if issue_number == 0 {
        return Err("no issue number to label (a positive integer is required)".to_string());
    }
    probe_gh(binary, PROBE_ACTION)?;
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/{issue_number}/labels");
    let labels_arg = format!("labels[]={name}");
    let out = run_gh_bounded(
        dir,
        binary,
        &["api", "--method", "POST", &endpoint, "-f", &labels_arg],
        None,
        deadline,
        "timed out adding the status label on GitHub — check your network and try again",
    )?;
    if out.status.success() {
        return Ok(());
    }
    Err(map_gh_failure(binary, "api", &out))
}

/// Remove `name` from the issue (`DELETE …/issues/{n}/labels/{name}`). A 404 (the label is
/// already absent) is SUCCESS — the removal is idempotent.
pub(super) fn remove_label_with(
    dir: &Path,
    binary: &str,
    issue_number: u64,
    name: &str,
    deadline: Duration,
) -> Result<(), String> {
    if issue_number == 0 {
        return Err("no issue number to unlabel (a positive integer is required)".to_string());
    }
    probe_gh(binary, PROBE_ACTION)?;
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/{issue_number}/labels/{name}");
    let out = run_gh_bounded(
        dir,
        binary,
        &["api", "--method", "DELETE", &endpoint],
        None,
        deadline,
        "timed out removing the status label on GitHub — check your network and try again",
    )?;
    if out.status.success() || http_status(&out) == Some(404) {
        return Ok(());
    }
    Err(map_gh_failure(binary, "api", &out))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write an executable shell script standing in for `gh`, so the tests exercise the
    /// real spawn + argv + exit-code mapping (the `create_pr_with`/`post_issue_comment_with`
    /// fixture pattern) — never a mock, never live GitHub.
    #[cfg(unix)]
    fn fake_gh(dir: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-gh.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
        let mut perms = std::fs::metadata(&path).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod");
        path
    }

    #[test]
    fn label_vocabulary_has_five_fixed_specs() {
        assert_eq!(LABEL_SPECS.len(), 5);
        assert_eq!(spec_for("in-progress").map(|s| s.color), Some("1d76db"));
        assert_eq!(full_name("nc:", "queued"), "nc:queued");
        assert!(spec_for("nonexistent").is_none());
    }

    #[test]
    fn http_status_parses_stderr_and_stdout() {
        let out = GhOutput {
            status: std::process::Command::new("true").status().unwrap(),
            stdout: String::new(),
            stderr: "gh: Validation Failed (HTTP 422)".into(),
        };
        assert_eq!(http_status(&out), Some(422));
        let out2 = GhOutput {
            status: std::process::Command::new("true").status().unwrap(),
            stdout: String::new(),
            stderr: "no code here".into(),
        };
        assert_eq!(http_status(&out2), None);
    }

    #[test]
    #[cfg(unix)]
    fn add_label_posts_labels_array_additively() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let gh = fake_gh(tmp.path(), "printf '%s\\n' \"$@\" > args.txt");
        add_label_with(
            tmp.path(),
            gh.to_str().unwrap(),
            42,
            "nc:queued",
            Duration::from_secs(5),
        )
        .expect("add succeeds");
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args");
        let args: Vec<&str> = args.lines().collect();
        for expected in [
            "api",
            "--method",
            "POST",
            "repos/{owner}/{repo}/issues/42/labels",
            "-f",
            "labels[]=nc:queued",
        ] {
            assert!(
                args.contains(&expected),
                "argv missing {expected}: {args:?}"
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn remove_label_deletes_the_right_path_and_tolerates_404() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        // Record argv, then exit non-zero with a 404 stderr — the tolerated case.
        let gh = fake_gh(
            tmp.path(),
            "printf '%s\\n' \"$@\" > args.txt\n\
             echo 'gh: Not Found (HTTP 404)' 1>&2\nexit 1",
        );
        remove_label_with(
            tmp.path(),
            gh.to_str().unwrap(),
            42,
            "nc:in-progress",
            Duration::from_secs(5),
        )
        .expect("a 404 is tolerated as already-absent");
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args");
        let args: Vec<&str> = args.lines().collect();
        assert!(args.contains(&"DELETE"));
        assert!(args.contains(&"repos/{owner}/{repo}/issues/42/labels/nc:in-progress"));
    }

    #[test]
    #[cfg(unix)]
    fn remove_label_surfaces_a_non_404_failure() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let gh = fake_gh(
            tmp.path(),
            "echo 'gh: Resource not accessible (HTTP 403)' 1>&2\nexit 1",
        );
        let err = remove_label_with(
            tmp.path(),
            gh.to_str().unwrap(),
            42,
            "nc:done",
            Duration::from_secs(5),
        )
        .expect_err("a 403 is not tolerated");
        assert!(err.contains("403"), "surfaces gh's stderr: {err}");
    }
}
