//! Unit + fake-`gh` integration tests for the PR-review post seams, kept together
//! so the diff-fetch and post cases share the `fake_gh` fixture.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::diff::{cap_diff, fetch_pr_diff_with, PR_DIFF_CAP};
use super::post::{build_review_payload, post_review_with, review_event, InlineComment};
use super::GH_TIMEOUT;
use crate::workflow::pr::GH_BINARY;

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
