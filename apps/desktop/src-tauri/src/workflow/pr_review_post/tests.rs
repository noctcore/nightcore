//! Unit + fake-`gh` integration tests for the PR-review post seams, kept together
//! so the diff-fetch and post cases share the `fake_gh` fixture.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::anchor::{parse_valid_anchors, prepare_survivable_review, sanitize_untrusted_md};
use super::diff::{
    cap_diff, fetch_pr_diff_raw_with, fetch_pr_diff_with, fetch_pr_head_oid_with, PR_DIFF_CAP,
};
use super::post::{
    build_review_payload, post_review_survivable_with, post_review_with, review_event,
    InlineComment,
};
use super::GH_TIMEOUT;
use crate::git::gh::GH_BINARY;

/// A three-file unified diff (a modify, a delete, an add) — the fixture the anchor
/// tests parse. `src/a.ts` has context + removed + added lines; `src/gone.ts` is
/// deleted (`+++ /dev/null`); `src/new.ts` is a brand-new file.
const SAMPLE_DIFF: &str = "\
diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 line1
-old2
+new2
+new3
 line4
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+x
+y
+z
";

/// Build an inline comment tersely for the survivability tests.
fn ic(path: &str, line: u64, body: &str) -> InlineComment {
    InlineComment {
        path: path.into(),
        line,
        body: body.into(),
    }
}

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
#[cfg(unix)]
fn post_review_failure_surfaces_the_error_body_details_from_stdout() {
    // `gh api` prints GitHub's error-response JSON to STDOUT; stderr carries only the
    // bare status line. The mapper must join the body's `errors[]` (both the plain-
    // string and `{message}` object forms) onto the message — this is where GitHub
    // names the real reason (own-PR rule, an inline anchor outside the diff, …).
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let script = fake_gh(
        tmp.path(),
        "cat > /dev/null\n\
         echo '{\"message\":\"Unprocessable Entity\",\"errors\":[\"Can not request changes on your own pull request\",{\"message\":\"line must be part of the diff\"}]}'\n\
         echo 'gh: Unprocessable Entity (HTTP 422)' >&2\nexit 1",
    );
    let err = post_review_with(
        tmp.path(),
        script.to_str().expect("utf8 path"),
        42,
        "request-changes",
        "b",
        &[],
        GH_TIMEOUT,
    )
    .expect_err("a non-zero exit must be an Err");
    assert!(
        err.contains("Can not request changes on your own pull request"),
        "string-form errors[] detail is surfaced: {err}"
    );
    assert!(
        err.contains("line must be part of the diff"),
        "object-form errors[] detail is surfaced: {err}"
    );
}

#[test]
#[cfg(unix)]
fn post_review_bare_422_on_a_non_comment_verdict_names_the_own_pr_rule() {
    // A 422 with NO body detail on approve/request-changes is (in practice) GitHub's
    // undocumented-in-the-response own-PR refusal — the mapper spells the rule out.
    // The same bare 422 on a COMMENT verdict (allowed on own PRs) gets no such hint.
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let script = fake_gh(
        tmp.path(),
        "cat > /dev/null\necho 'gh: Unprocessable Entity (HTTP 422)' >&2\nexit 1",
    );
    let bin = script.to_str().expect("utf8 path");
    let err = post_review_with(tmp.path(), bin, 42, "request-changes", "b", &[], GH_TIMEOUT)
        .expect_err("non-zero exit");
    assert!(
        err.contains("pull request you authored"),
        "request-changes 422 names the own-PR rule: {err}"
    );
    let err = post_review_with(tmp.path(), bin, 42, "comment", "b", &[], GH_TIMEOUT)
        .expect_err("non-zero exit");
    assert!(
        !err.contains("pull request you authored"),
        "a comment 422 must NOT claim the own-PR rule: {err}"
    );
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

#[test]
#[cfg(unix)]
fn fetch_pr_head_oid_with_reads_the_head_ref_oid_and_uses_pr_view() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let script = fake_gh(
        tmp.path(),
        "printf '%s\\n' \"$@\" >> args.txt\nprintf '{\"headRefOid\":\"deadbeefcafe\"}'\nexit 0",
    );
    let sha = fetch_pr_head_oid_with(
        tmp.path(),
        script.to_str().expect("utf8 path"),
        7,
        GH_TIMEOUT,
    )
    .expect("head oid fetch succeeds");
    assert_eq!(sha, "deadbeefcafe");
    let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args");
    // `gh pr view <n> --json headRefOid` with the decimal number (injection-safe).
    assert!(args.contains("view"), "uses pr view: {args}");
    assert!(args.contains("headRefOid"), "asks for headRefOid: {args}");
    assert!(args.contains("7"), "passes the decimal number: {args}");
}

#[test]
#[cfg(unix)]
fn fetch_pr_head_oid_with_absent_field_degrades_to_empty() {
    // A view response missing headRefOid (gh drift) yields "" — the caller reads that as
    // "no reviewed-head marker", never an error that would fail the whole review.
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let script = fake_gh(tmp.path(), "printf '{}'\nexit 0");
    let sha = fetch_pr_head_oid_with(
        tmp.path(),
        script.to_str().expect("utf8 path"),
        7,
        GH_TIMEOUT,
    )
    .expect("empty object still parses");
    assert_eq!(sha, "");
}

#[test]
#[cfg(unix)]
fn fetch_pr_head_oid_with_surfaces_stderr_on_failure() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let script = fake_gh(
        tmp.path(),
        "echo 'gh: no pull requests found for branch' >&2\nexit 1",
    );
    let err = fetch_pr_head_oid_with(
        tmp.path(),
        script.to_str().expect("utf8 path"),
        5,
        GH_TIMEOUT,
    )
    .expect_err("a failed view is an Err");
    assert!(
        err.contains("no pull requests found"),
        "verbatim stderr: {err}"
    );
}

#[test]
fn fetch_pr_head_oid_with_rejects_zero_pr_number() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let err =
        fetch_pr_head_oid_with(tmp.path(), GH_BINARY, 0, GH_TIMEOUT).expect_err("pr 0 is rejected");
    assert!(err.contains("valid PR number"), "err: {err}");
}

// ─── Review-post survivability (T10): diff-anchored validation + demote + stale head ───

#[test]
fn parse_valid_anchors_records_right_side_context_and_added_lines() {
    let anchors = parse_valid_anchors(SAMPLE_DIFF);
    // `src/a.ts`: context line1 (new 1), removed `old2` (no new line), added new2/new3
    // (new 2/3), context line4 (new 4). The removed line never claims a right-side anchor.
    let a: Vec<u64> = {
        let mut v: Vec<u64> = anchors
            .get("src/a.ts")
            .expect("a.ts present")
            .iter()
            .copied()
            .collect();
        v.sort_unstable();
        v
    };
    assert_eq!(
        a,
        vec![1, 2, 3, 4],
        "context + added lines anchor; removed does not"
    );
    // `src/new.ts`: a brand-new file — every added line (new 1..=3) is anchorable.
    let n: Vec<u64> = {
        let mut v: Vec<u64> = anchors
            .get("src/new.ts")
            .expect("new.ts present")
            .iter()
            .copied()
            .collect();
        v.sort_unstable();
        v
    };
    assert_eq!(
        n,
        vec![1, 2, 3],
        "an added file anchors on every added line"
    );
    // `src/gone.ts` was deleted (`+++ /dev/null`) — it contributes NO right-side anchors.
    assert!(
        !anchors.contains_key("src/gone.ts"),
        "a deleted file has no right-side anchors"
    );
}

#[test]
fn parse_valid_anchors_on_an_empty_diff_is_empty() {
    assert!(parse_valid_anchors("").is_empty());
}

#[test]
fn prepare_survivable_review_keeps_all_when_every_comment_anchors() {
    // Every comment lands on a valid right-side line → nothing demoted, head unchanged →
    // the body is posted verbatim and all comments stay inline.
    let comments = vec![
        ic("src/a.ts", 2, "added line"),
        ic("src/new.ts", 3, "new file line"),
    ];
    let prepared = prepare_survivable_review(
        "Overall: looks good.",
        &comments,
        SAMPLE_DIFF,
        Some("sha"),
        "sha",
    );
    assert_eq!(prepared.comments.len(), 2, "both comments anchor inline");
    assert_eq!(
        prepared.body, "Overall: looks good.",
        "an all-anchorable, non-stale post leaves the body untouched"
    );
}

#[test]
fn prepare_survivable_review_demotes_un_anchorable_comments_into_the_body() {
    // Mixed: two anchor (a.ts:2, new.ts:3), two don't (a.ts:99 is outside the hunk;
    // gone.ts:1 is a deleted file). The review STILL posts — the two bad anchors are
    // demoted into the body, never dropped, never left to 422 the whole post.
    let comments = vec![
        ic("src/a.ts", 2, "anchors fine"),
        ic("src/a.ts", 99, "line 99 is outside the changed hunk"),
        ic("src/gone.ts", 1, "this file was deleted"),
        ic("src/new.ts", 3, "new file tail"),
    ];
    let prepared =
        prepare_survivable_review("Summary body.", &comments, SAMPLE_DIFF, Some("sha"), "sha");
    // Only the two anchorable comments remain inline.
    assert_eq!(
        prepared.comments.len(),
        2,
        "un-anchorable comments are removed from inline"
    );
    assert!(prepared.comments.iter().all(|c| c.line != 99));
    // The body carries the original summary + a demoted section listing `path:line`.
    assert!(
        prepared.body.starts_with("Summary body."),
        "original body is preserved"
    );
    assert!(
        prepared.body.contains("couldn't be anchored inline"),
        "a demote section is added: {}",
        prepared.body
    );
    assert!(
        prepared.body.contains("`src/a.ts:99`"),
        "the out-of-hunk finding is listed"
    );
    assert!(
        prepared.body.contains("`src/gone.ts:1`"),
        "the deleted-file finding is listed"
    );
    assert!(
        prepared.body.contains("this file was deleted"),
        "our finding text (trusted) is carried into the body"
    );
}

#[test]
fn prepare_survivable_review_notes_a_stale_head() {
    // The reviewed head differs from the current head → an honest note is prepended, and
    // the anchors are (implicitly) re-validated against the current diff.
    let comments = vec![ic("src/a.ts", 2, "anchors fine")];
    let prepared = prepare_survivable_review(
        "Body.",
        &comments,
        SAMPLE_DIFF,
        Some("abcdef1234567890"),
        "1122334455667788",
    );
    assert_eq!(
        prepared.comments.len(),
        1,
        "the still-valid anchor survives a moved head"
    );
    assert!(
        prepared.body.contains("the PR head advanced"),
        "a stale-head note is added: {}",
        prepared.body
    );
    // The short SHAs (first 12 chars) of BOTH heads appear — presentation only.
    assert!(
        prepared.body.contains("abcdef123456"),
        "reviewed short-sha shown"
    );
    assert!(
        prepared.body.contains("112233445566"),
        "current short-sha shown"
    );
}

#[test]
fn prepare_survivable_review_matching_head_adds_no_stale_note() {
    let comments = vec![ic("src/a.ts", 2, "x")];
    let prepared = prepare_survivable_review(
        "Body.",
        &comments,
        SAMPLE_DIFF,
        Some("same-sha"),
        "same-sha",
    );
    assert!(
        !prepared.body.contains("PR head advanced"),
        "an unchanged head adds no note"
    );
}

#[test]
fn prepare_survivable_review_unverified_head_is_surfaced_not_silently_passed() {
    // No stored reviewed head (older run / post outside a run) → an HONEST "couldn't be
    // verified" note is added (never a silent pass), and the out-of-diff comment is still
    // demoted (anchoring is validated regardless of head).
    let comments = vec![ic("src/a.ts", 2, "ok"), ic("src/a.ts", 99, "outside")];
    let prepared = prepare_survivable_review("Body.", &comments, SAMPLE_DIFF, None, "current-sha");
    assert!(
        prepared.body.contains("couldn't be verified"),
        "an unverifiable head is surfaced, not silently dropped: {}",
        prepared.body
    );
    assert!(
        !prepared.body.contains("PR head advanced"),
        "the unverified note is distinct from the moved-head note"
    );
    assert_eq!(
        prepared.comments.len(),
        1,
        "the out-of-diff comment is still demoted"
    );
    assert!(prepared.body.contains("`src/a.ts:99`"));
}

#[test]
fn prepare_survivable_review_unreadable_current_head_is_also_surfaced() {
    // The reviewed head is known but the current head couldn't be read (empty) → still
    // Unverified, still surfaced (we can't confirm the anchors reflect the reviewed code).
    let comments = vec![ic("src/a.ts", 2, "ok")];
    let prepared = prepare_survivable_review("Body.", &comments, SAMPLE_DIFF, Some("reviewed"), "");
    assert!(
        prepared.body.contains("couldn't be verified"),
        "an unreadable current head is surfaced: {}",
        prepared.body
    );
}

// ─── Untrusted-content sanitization (Finding 1: no markdown injection in the body) ─────

#[test]
fn sanitize_untrusted_md_neutralizes_mentions_links_images_html_and_backticks() {
    let dirty = "see @Shironex/maintainers and [x](http://evil) and ![](http://evil/img) \
                 and `code` and <script>alert(1)</script>\nsecond line #42";
    let clean = sanitize_untrusted_md(dirty);
    assert!(!clean.contains('@'), "no @ mention sigil survives: {clean}");
    assert!(!clean.contains('`'), "no backtick survives: {clean}");
    assert!(
        !clean.contains('<') && !clean.contains('>'),
        "no angle brackets: {clean}"
    );
    assert!(
        !clean.contains('[') && !clean.contains(']'),
        "no link/image brackets: {clean}"
    );
    assert!(
        !clean.contains("://"),
        "no autolink scheme separator: {clean}"
    );
    assert!(!clean.contains("]("), "no residual link syntax: {clean}");
    assert!(
        !clean.contains('\n'),
        "newlines collapse to spaces: {clean}"
    );
    // The text is preserved, only the dangerous sigils neutralized.
    assert!(
        clean.contains("(at)Shironex/maintainers"),
        "the mention is defanged, not dropped: {clean}"
    );
    assert!(
        clean.contains("(hash)42"),
        "the issue-ref sigil is defanged: {clean}"
    );
}

#[test]
fn prepare_survivable_review_sanitizes_a_malicious_path_and_body_in_the_demote_section() {
    // The exploit from the review: a file literally named `src/x`@org/team`.ts` (backtick
    // breakout + team mention) whose finding demotes, and a body carrying @mention /
    // markdown link / image / raw HTML / backtick / newline. NONE may survive as live
    // markdown in the body — which is composed AFTER the human approval gate.
    let attack_path = "src/x`@Shironex/maintainers`.ts";
    let attack_body = "ping @Shironex/maintainers see [click](http://evil) \
                       ![](http://evil/img) `x` <b>hi</b>\nline2";
    // line 1 of a file not in the diff ⇒ demoted into the body.
    let comments = vec![ic(attack_path, 1, attack_body)];
    let prepared =
        prepare_survivable_review("Summary.", &comments, SAMPLE_DIFF, Some("sha"), "sha");
    let body = &prepared.body;
    assert!(
        body.contains("couldn't be anchored inline"),
        "the finding is demoted, not dropped: {body}"
    );
    // No live mention, no link/image/HTML syntax, no autolink anywhere in the posted body.
    assert!(!body.contains('@'), "no @ mention survives: {body}");
    assert!(!body.contains("]("), "no link syntax survives: {body}");
    assert!(!body.contains("://"), "no autolink scheme survives: {body}");
    assert!(!body.contains("!["), "no image syntax survives: {body}");
    assert!(
        !body.contains('<') && !body.contains('>'),
        "no raw HTML survives: {body}"
    );
    // Every backtick left is a code-span delimiter WE added: the one demoted `path:line`
    // span is exactly two. The attacker's backticks were stripped, so the path code span
    // cannot be broken out of.
    assert_eq!(
        body.matches('`').count(),
        2,
        "only our own code-span delimiters remain: {body}"
    );
}

#[test]
fn prepare_survivable_review_empty_diff_demotes_everything_and_still_posts() {
    // An empty diff (nothing anchorable) demotes ALL comments into the body — the review
    // still posts (with an empty inline set), losing no finding.
    let comments = vec![ic("src/a.ts", 2, "one"), ic("src/b.ts", 5, "two")];
    let prepared = prepare_survivable_review("Body.", &comments, "", Some("sha"), "sha");
    assert!(
        prepared.comments.is_empty(),
        "no comment can anchor on an empty diff"
    );
    assert!(prepared.body.contains("`src/a.ts:2`"));
    assert!(prepared.body.contains("`src/b.ts:5`"));
}

#[test]
#[cfg(unix)]
fn fetch_pr_diff_raw_with_returns_the_uncapped_diff_in_a_single_call() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    // Records argv (proving one `pr diff` call, no `--name-only`) and emits a diff far
    // OVER the cap — the raw fetch must NOT truncate it (unlike `fetch_pr_diff_with`).
    let script = fake_gh(
        tmp.path(),
        "printf '%s\\n' \"$@\" >> args.txt\nyes 'X' | head -c 600000\nexit 0",
    );
    let diff = fetch_pr_diff_raw_with(
        tmp.path(),
        script.to_str().expect("utf8 path"),
        9,
        GH_TIMEOUT,
    )
    .expect("raw fetch succeeds");
    assert!(
        diff.len() > PR_DIFF_CAP,
        "the raw diff is returned uncapped"
    );
    assert!(
        !diff.contains("[diff truncated at"),
        "the raw fetch never appends the cap marker"
    );
    let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args");
    assert!(args.contains("diff"), "uses pr diff: {args}");
    assert!(args.contains('9'), "passes the decimal number: {args}");
    assert!(
        !args.contains("--name-only"),
        "the raw fetch makes only the diff call: {args}"
    );
}

#[test]
fn fetch_pr_diff_raw_with_rejects_zero_pr_number() {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let err =
        fetch_pr_diff_raw_with(tmp.path(), GH_BINARY, 0, GH_TIMEOUT).expect_err("pr 0 is rejected");
    assert!(err.contains("valid PR number"), "err: {err}");
}

/// A fake `gh` that answers the THREE calls `post_review_survivable_with` makes: `pr diff
/// <n>` (serves `diff.txt` from cwd), `pr view … headRefOid` (a canned current head), and
/// the `api …/reviews` POST (records stdin to `payload.json`). Any other invocation fails.
#[cfg(unix)]
fn fake_gh_survivable(dir: &Path) -> PathBuf {
    fake_gh(
        dir,
        "if [ \"$1\" = \"api\" ]; then cat > payload.json; exit 0; fi\n\
         if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"diff\" ]; then cat diff.txt; exit 0; fi\n\
         if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"view\" ]; then printf '{\"headRefOid\":\"current-head-sha\"}'; exit 0; fi\n\
         echo 'unexpected gh call' >&2; exit 1",
    )
}

#[test]
#[cfg(unix)]
fn post_review_survivable_with_demotes_an_out_of_diff_anchor_and_still_posts() {
    // The end-to-end wiring: fetch the diff + head, re-anchor, then POST one review. A
    // finding on a line OUTSIDE the diff (which real GitHub would 422 the WHOLE review
    // over) is demoted into the body — the post still lands with the anchorable comment.
    let tmp = tempfile::TempDir::new().expect("temp dir");
    std::fs::write(tmp.path().join("diff.txt"), SAMPLE_DIFF).expect("write diff");
    let script = fake_gh_survivable(tmp.path());
    let comments = vec![
        ic("src/a.ts", 2, "anchors on an added line"),
        ic("src/a.ts", 99, "line 99 is outside the diff"),
    ];
    post_review_survivable_with(
        tmp.path(),
        script.to_str().expect("utf8 path"),
        42,
        "comment",
        "Overall summary.",
        &comments,
        Some("reviewed-head-sha"), // differs from the fake's current head ⇒ stale note
        GH_TIMEOUT,
    )
    .expect("the survivable post lands despite the bad anchor");

    let payload = std::fs::read_to_string(tmp.path().join("payload.json")).expect("payload posted");
    let v: Value = serde_json::from_str(&payload).expect("valid JSON on stdin");
    // Only the anchorable comment is posted inline (the out-of-diff one was demoted).
    assert_eq!(
        v["comments"].as_array().unwrap().len(),
        1,
        "the out-of-diff comment is removed from the inline set"
    );
    assert_eq!(v["comments"][0]["path"], "src/a.ts");
    assert_eq!(v["comments"][0]["line"], 2);
    // The demoted finding + the stale-head note ride along in the body — nothing dropped.
    let body = v["body"].as_str().unwrap();
    assert!(
        body.starts_with("Overall summary."),
        "original body preserved: {body}"
    );
    assert!(
        body.contains("`src/a.ts:99`"),
        "the demoted finding is listed: {body}"
    );
    assert!(
        body.contains("the PR head advanced"),
        "a stale-head note is present: {body}"
    );
    assert!(
        body.contains("current-head"),
        "the current short-sha is shown: {body}"
    );
}

#[test]
#[cfg(unix)]
fn post_review_survivable_with_no_comments_skips_the_diff_fetch() {
    // With no inline comments there is nothing to anchor: the diff/head reads are skipped
    // entirely (this fake FAILS any `pr` call) and the body posts verbatim.
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let script = fake_gh(
        tmp.path(),
        "if [ \"$1\" = \"api\" ]; then cat > payload.json; exit 0; fi\n\
         echo 'the diff/head fetch must be skipped when there are no comments' >&2; exit 1",
    );
    post_review_survivable_with(
        tmp.path(),
        script.to_str().expect("utf8 path"),
        42,
        "approve",
        "LGTM",
        &[],
        None,
        GH_TIMEOUT,
    )
    .expect("a comment-free post skips the diff fetch and lands");
    let payload = std::fs::read_to_string(tmp.path().join("payload.json")).expect("payload posted");
    let v: Value = serde_json::from_str(&payload).expect("valid JSON");
    assert_eq!(v["event"], "APPROVE");
    assert_eq!(v["body"], "LGTM");
    assert!(v["comments"].as_array().unwrap().is_empty());
}
