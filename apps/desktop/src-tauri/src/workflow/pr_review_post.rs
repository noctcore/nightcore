//! PR Review — the network-facing `gh` seams (design §6, phase 4).
//!
//! Two `gh` operations sit on the Rust side so the read-only review sessions stay
//! network-free:
//! - [`fetch_pr_diff`] — resolve a PR's `gh pr diff <n>` output + changed-file set,
//!   bounded and CAPPED, so `start_pr_review` (the sidecar bridge) can pass the diff
//!   inline on the start command. Called on the blocking pool (it talks to GitHub).
//! - [`post_review_to_github`] — the human-gated terminal action: POST one atomic
//!   GitHub review (`{event, body, comments[]}`) built with serde_json (never string
//!   formatting) via `gh api …/reviews --input -`, body on STDIN.
//!
//! Safety posture (the PR-arc rules, unchanged): every `gh` child bounded by a
//! deadline via [`super::pr::run_gh_bounded`]; `gh` is the seam and stores no tokens;
//! `pr_number` is a `u64` (decimal, injection-safe); the review body + comment text is
//! Nightcore-authored (our own findings) — trusted — so raw foreign diff text is never
//! echoed back into a comment. `{owner}`/`{repo}` are `gh` placeholders resolved from
//! the run cwd, never a raw remote URL across IPC.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::merge::require_project;
use super::pr::{run_gh_bounded, GH_BINARY};
use crate::store::TaskStore;

/// Wall-clock bound on every network-facing PR-review `gh` spawn (diff fetch + post).
/// Same rationale as the create/status bounds: generous but finite — a black-holed
/// GitHub must error out, not pin the blocking thread.
const GH_TIMEOUT: Duration = Duration::from_secs(120);

/// Cap on the resolved PR diff handed to the sidecar (512 KiB). A gargantuan diff would
/// blow the review prompt's context budget; past the cap we truncate + append a marker
/// so the model reviews the leading slice and knows the tail was elided.
pub(crate) const PR_DIFF_CAP: usize = 512 * 1024;

/// The GitHub review verdict, mapped to the `gh` API `event` enum. The web sends the
/// kebab form (`approve` / `request-changes` / `comment`); the uppercase `gh` forms are
/// accepted defensively. Any other value is rejected.
fn review_event(verdict: &str) -> Result<&'static str, String> {
    match verdict {
        "approve" | "APPROVE" => Ok("APPROVE"),
        "request-changes" | "REQUEST_CHANGES" => Ok("REQUEST_CHANGES"),
        "comment" | "COMMENT" => Ok("COMMENT"),
        other => Err(format!(
            "invalid review verdict `{other}` — expected one of approve, request-changes, comment"
        )),
    }
}

/// One inline review comment posted alongside the review: an anchor (`path` + `line` in
/// the PR head) plus the Nightcore-authored `body`. Built by the web/command layer from
/// the selected findings that carry a line. Deserialize-only (the web constructs the
/// literal), so it needs no ts-rs export.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineComment {
    pub path: String,
    pub line: u64,
    pub body: String,
}

/// Truncate `diff` to at most `cap` bytes at a UTF-8 char boundary, appending a marker
/// when it overflows. Pure, unit-testable.
fn cap_diff(mut diff: String, cap: usize) -> String {
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
fn fetch_pr_diff_with(
    dir: &Path,
    binary: &str,
    pr_number: u64,
    deadline: Duration,
) -> Result<(String, Vec<String>), String> {
    if pr_number == 0 {
        return Err("enter a valid PR number (a positive integer)".to_string());
    }
    // Probe with `which` (PATHEXT-aware) so a missing gh reads as "install it", and a
    // spawn-time NotFound after a green probe reads as the vanished-cwd launch failure
    // it actually is (run_gh_bounded's mapping) — never as a missing tool.
    if which::which(binary).is_err() {
        return Err(
            "GitHub CLI (`gh`) is not installed — install it to review pull requests".to_string(),
        );
    }
    let number = pr_number.to_string();

    let diff_out = run_gh_bounded(
        dir,
        binary,
        &["pr", "diff", &number],
        None,
        deadline,
        "timed out fetching the PR diff from GitHub — check your network and try again",
    )?;
    if !diff_out.status.success() {
        let stderr = diff_out.stderr.trim();
        return Err(if stderr.is_empty() {
            format!(
                "`{binary} pr diff` failed (exit {:?})",
                diff_out.status.code()
            )
        } else {
            stderr.to_string()
        });
    }
    let diff = cap_diff(diff_out.stdout, PR_DIFF_CAP);

    let names_out = run_gh_bounded(
        dir,
        binary,
        &["pr", "diff", &number, "--name-only"],
        None,
        deadline,
        "timed out fetching the PR changed files from GitHub — check your network and try again",
    )?;
    if !names_out.status.success() {
        let stderr = names_out.stderr.trim();
        return Err(if stderr.is_empty() {
            format!(
                "`{binary} pr diff --name-only` failed (exit {:?})",
                names_out.status.code()
            )
        } else {
            stderr.to_string()
        });
    }
    let changed_files: Vec<String> = names_out
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();

    Ok((diff, changed_files))
}

/// Build the `gh api …/reviews` JSON payload with serde_json (NEVER string formatting):
/// `{ event, body, comments: [{path, line, body}, …] }`. Pure, unit-testable.
fn build_review_payload(event: &str, body: &str, comments: &[InlineComment]) -> String {
    let comments_json: Vec<Value> = comments
        .iter()
        .map(|c| json!({ "path": c.path, "line": c.line, "body": c.body }))
        .collect();
    let payload = json!({ "event": event, "body": body, "comments": comments_json });
    // A `serde_json::Value` always serializes; `to_string` cannot fail here.
    payload.to_string()
}

/// Post one atomic GitHub review to a PR (binary-parameterized seam — the tests
/// exercise the real spawn + stdin + exit-code mapping with a fake `gh`). Validates the
/// verdict, `which`-probes `gh`, builds the payload with serde_json, and POSTs it via
/// `gh api --method POST repos/{owner}/{repo}/pulls/<n>/reviews --input -` with the
/// payload on STDIN (never argv). `gh` resolves `{owner}`/`{repo}` from the repo in
/// `dir`. Surfaces `gh`'s stderr verbatim on a non-zero exit.
fn post_review_with(
    dir: &Path,
    binary: &str,
    pr_number: u64,
    verdict: &str,
    body: &str,
    comments: &[InlineComment],
    deadline: Duration,
) -> Result<(), String> {
    if pr_number == 0 {
        return Err(
            "no PR number to post a review to (a positive integer is required)".to_string(),
        );
    }
    // Validate the verdict BEFORE any probe/spawn so a bad value fails cheaply.
    let event = review_event(verdict)?;
    if which::which(binary).is_err() {
        return Err(
            "GitHub CLI (`gh`) is not installed — install it to post pull-request reviews"
                .to_string(),
        );
    }
    let payload = build_review_payload(event, body, comments);
    let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{pr_number}/reviews");
    let out = run_gh_bounded(
        dir,
        binary,
        &["api", "--method", "POST", &endpoint, "--input", "-"],
        Some(&payload),
        deadline,
        "timed out posting the review to GitHub — check your network and try again",
    )?;
    if !out.status.success() {
        let stderr = out.stderr.trim();
        return Err(if stderr.is_empty() {
            format!("`{binary} api` failed (exit {:?})", out.status.code())
        } else {
            // gh's stderr explains itself (auth, rate limit, unknown repo, …).
            stderr.to_string()
        });
    }
    Ok(())
}

/// Post a Nightcore-composed review to a GitHub pull request of the active project. The
/// human gate lives on the web side (a ConfirmDialog); here we just do the work. The
/// `body` + comment text are OUR OWN findings (trusted); this never echoes raw foreign
/// diff text. Runs off the UI thread (the network `gh` spawn must not block the WKWebView).
#[tauri::command]
pub async fn post_review_to_github(
    app: AppHandle,
    pr_number: u64,
    verdict: String,
    body: String,
    comments: Vec<InlineComment>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        post_review_blocking(&app, pr_number, &verdict, &body, &comments)
    })
    .await
    .map_err(|e| format!("post review failed to run: {e}"))?
}

/// The blocking body of [`post_review_to_github`]: resolve the active project (its root
/// is the `gh` cwd, which resolves `{owner}`/`{repo}`), then post.
fn post_review_blocking(
    app: &AppHandle,
    pr_number: u64,
    verdict: &str,
    body: &str,
    comments: &[InlineComment],
) -> Result<(), String> {
    // Touch the task store so a mis-wired managed state surfaces here rather than as a
    // confusing gh failure (parity with the sibling PR commands' state discipline).
    let _ = app.try_state::<TaskStore>();
    let project = require_project(app)?;
    let dir = std::path::PathBuf::from(&project.path);
    tracing::info!(target: "nightcore::pr", pr_number, verdict, comments = comments.len(), "posting PR review to GitHub");
    post_review_with(
        &dir, GH_BINARY, pr_number, verdict, body, comments, GH_TIMEOUT,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Write an executable shell script into `dir` to stand in for `gh`, so the tests
    /// exercise the real spawn + stdin + exit-code mapping (not a mock) — the phase-1/3
    /// fixture pattern.
    #[cfg(unix)]
    fn fake_gh(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-gh.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
        let mut perms = std::fs::metadata(&path)
            .expect("script metadata")
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod script");
        path
    }

    #[test]
    fn cap_diff_leaves_a_small_diff_untouched() {
        let diff = "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n".to_string();
        assert_eq!(cap_diff(diff.clone(), PR_DIFF_CAP), diff);
    }

    #[test]
    fn cap_diff_truncates_and_marks_overflow_at_a_char_boundary() {
        // A diff over the cap is truncated to the cap and a marker is appended. Use a
        // multi-byte char straddling the cap to prove the truncation lands on a boundary.
        let big = "é".repeat(1000); // 2000 bytes
        let capped = cap_diff(big, 999); // 999 is mid-`é` (odd) → must back off to 998
        assert!(capped.contains("[diff truncated at 999 bytes]"));
        // The kept prefix is valid UTF-8 (no panic building the String) and ends before
        // the marker; 998 bytes of content = 499 `é`s.
        let content = capped.split("\n[diff truncated").next().unwrap();
        assert_eq!(content.chars().filter(|&c| c == 'é').count(), 499);
    }

    #[test]
    fn review_event_maps_web_and_gh_forms_and_rejects_others() {
        assert_eq!(review_event("approve").unwrap(), "APPROVE");
        assert_eq!(review_event("request-changes").unwrap(), "REQUEST_CHANGES");
        assert_eq!(review_event("comment").unwrap(), "COMMENT");
        assert_eq!(review_event("APPROVE").unwrap(), "APPROVE");
        assert!(review_event("merge").is_err());
        assert!(review_event("").is_err());
    }

    #[test]
    fn build_review_payload_is_serde_json_not_string_formatting() {
        let comments = vec![
            InlineComment {
                path: "src/a.ts".into(),
                line: 12,
                body: "SQL injection risk here.".into(),
            },
            InlineComment {
                path: "src/b.ts".into(),
                line: 3,
                // A body with characters that would break naive string formatting.
                body: "Uses \"eval\" — replace it.\nSecond line.".into(),
            },
        ];
        let raw = build_review_payload("REQUEST_CHANGES", "Overall: needs work", &comments);
        // It round-trips as valid JSON with the exact structure the gh API expects.
        let v: Value = serde_json::from_str(&raw).expect("valid JSON");
        assert_eq!(v["event"], "REQUEST_CHANGES");
        assert_eq!(v["body"], "Overall: needs work");
        assert_eq!(v["comments"].as_array().unwrap().len(), 2);
        assert_eq!(v["comments"][0]["path"], "src/a.ts");
        assert_eq!(v["comments"][0]["line"], 12);
        assert_eq!(
            v["comments"][1]["body"],
            "Uses \"eval\" — replace it.\nSecond line."
        );
    }

    #[test]
    fn build_review_payload_with_no_comments_emits_an_empty_array() {
        let raw = build_review_payload("APPROVE", "LGTM", &[]);
        let v: Value = serde_json::from_str(&raw).expect("valid JSON");
        assert_eq!(v["event"], "APPROVE");
        assert!(v["comments"].as_array().unwrap().is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn post_review_with_posts_payload_on_stdin_never_argv() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        // The fake gh records its argv and its stdin, then exits 0.
        let script = fake_gh(
            tmp.path(),
            "printf '%s\\n' \"$@\" > args.txt\ncat > payload.json\nexit 0",
        );
        let comments = vec![InlineComment {
            path: "src/a.ts".into(),
            line: 12,
            body: "inline note".into(),
        }];
        post_review_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            42,
            "request-changes",
            "the review summary body",
            &comments,
            GH_TIMEOUT,
        )
        .expect("post succeeds");

        // The payload arrived on stdin, as valid JSON with the mapped event.
        let payload = std::fs::read_to_string(tmp.path().join("payload.json")).expect("payload");
        let v: Value = serde_json::from_str(&payload).expect("valid JSON on stdin");
        assert_eq!(v["event"], "REQUEST_CHANGES");
        assert_eq!(v["body"], "the review summary body");
        assert_eq!(v["comments"][0]["path"], "src/a.ts");

        // The argv carries the api/POST/reviews contract and stdin flag — never the body.
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args");
        let args: Vec<&str> = args.lines().collect();
        assert!(
            !args.iter().any(|a| a.contains("review summary body")),
            "the body must not appear in argv: {args:?}"
        );
        for expected in [
            "api",
            "--method",
            "POST",
            "repos/{owner}/{repo}/pulls/42/reviews",
            "--input",
            "-",
        ] {
            assert!(
                args.contains(&expected),
                "argv missing {expected}: {args:?}"
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn post_review_with_surfaces_stderr_verbatim_on_failure() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "cat > /dev/null\necho 'gh: Not Found (HTTP 404)' >&2\nexit 1",
        );
        let err = post_review_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            42,
            "approve",
            "b",
            &[],
            GH_TIMEOUT,
        )
        .expect_err("a non-zero exit must be an Err");
        assert!(err.contains("Not Found"), "gh's stderr is verbatim: {err}");
    }

    #[test]
    fn post_review_with_rejects_a_bad_verdict_before_any_spawn() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        // The binary doesn't exist — but verdict validation runs FIRST, so the outcome is
        // the validation error, not a ToolAbsent/launch failure: proof no probe/spawn ran.
        let err = post_review_with(
            tmp.path(),
            "definitely-not-a-real-binary-xyz",
            42,
            "lgtm",
            "b",
            &[],
            GH_TIMEOUT,
        )
        .expect_err("a bad verdict is rejected");
        assert!(err.contains("invalid review verdict"), "err: {err}");
    }

    #[test]
    fn post_review_with_absent_gh_is_a_clear_install_message() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let err = post_review_with(
            tmp.path(),
            "definitely-not-a-real-binary-xyz",
            42,
            "approve", // a VALID verdict, so we reach the which-probe
            "b",
            &[],
            GH_TIMEOUT,
        )
        .expect_err("a missing gh is an Err");
        assert!(err.contains("not installed"), "err: {err}");
    }

    #[test]
    #[cfg(unix)]
    fn fetch_pr_diff_with_caps_the_diff_and_splits_the_name_list() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        // The fake gh distinguishes the two calls by the presence of --name-only ($4).
        let script = fake_gh(
            tmp.path(),
            r#"if [ "$4" = "--name-only" ]; then
  printf 'src/a.ts\n\nsrc/b.ts\n'
else
  # A diff far over the cap so truncation triggers.
  yes 'X' | head -c 600000
fi
exit 0"#,
        );
        let (diff, files) = fetch_pr_diff_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            7,
            GH_TIMEOUT,
        )
        .expect("fetch succeeds");
        assert!(
            diff.contains("[diff truncated at"),
            "an over-cap diff is truncated with a marker"
        );
        assert!(
            diff.len() <= PR_DIFF_CAP + 64,
            "the capped diff stays near the cap"
        );
        // Blank lines are dropped; both files survive.
        assert_eq!(files, vec!["src/a.ts".to_string(), "src/b.ts".to_string()]);
    }

    #[test]
    #[cfg(unix)]
    fn fetch_pr_diff_with_passes_the_decimal_number_and_uses_pr_diff() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "printf '%s\\n' \"$@\" >> args.txt\nprintf 'src/a.ts\\n'\nexit 0",
        );
        let (_diff, files) = fetch_pr_diff_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            123,
            GH_TIMEOUT,
        )
        .expect("fetch succeeds");
        assert_eq!(files, vec!["src/a.ts".to_string()]);
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args");
        // Both calls use `pr diff` with the decimal number (injection-safe).
        assert!(args.contains("pr"), "uses pr subcommand: {args}");
        assert!(args.contains("diff"), "uses diff subcommand: {args}");
        assert!(args.contains("123"), "passes the decimal number: {args}");
        assert!(
            args.contains("--name-only"),
            "second call is name-only: {args}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn fetch_pr_diff_with_surfaces_stderr_on_a_failed_diff() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "echo 'gh: no pull requests found for branch' >&2\nexit 1",
        );
        let err = fetch_pr_diff_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            5,
            GH_TIMEOUT,
        )
        .expect_err("a failed diff is an Err");
        assert!(
            err.contains("no pull requests found"),
            "verbatim stderr: {err}"
        );
    }

    #[test]
    fn fetch_pr_diff_with_rejects_zero_pr_number() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let err =
            fetch_pr_diff_with(tmp.path(), GH_BINARY, 0, GH_TIMEOUT).expect_err("pr 0 is rejected");
        assert!(err.contains("valid PR number"), "err: {err}");
    }
}
