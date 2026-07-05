//! The terminal post seam: build ONE issue comment body from the STRUCTURED verdict
//! (never raw model prose / transcript) and POST it via a single atomic
//! `gh api repos/{owner}/{repo}/issues/{n}/comments --method POST --input -` with the
//! JSON body on STDIN (never interpolated into argv). The human gate + the per-root
//! mutation lease live on the command side (`sidecar::issue_triage`); here we build +
//! post.
//!
//! The body is composed from the persisted [`StoredIssueValidationResult`] fields, so
//! the preview the UI shows (built by the SAME builder over the SAME stored verdict)
//! is byte-identical to what is posted — the command never accepts a free-form body
//! from the web.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use super::GH_TIMEOUT;
use crate::store::issue_triage::StoredIssueValidationResult;
use crate::workflow::pr::{map_gh_failure, probe_gh, run_gh_bounded, GhOutput, GH_BINARY};

/// Format epoch-ms as a `YYYY-MM-DD` UTC date, without a date dependency (Howard
/// Hinnant's civil-from-days algorithm — the same one `store::project` uses). Pure so
/// the builder stays deterministic (preview == post).
pub(crate) fn format_utc_date(epoch_ms: u64) -> String {
    let days = (epoch_ms / 86_400_000) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Humanize a snake_case wire enum string for display in the comment (`needs_clarification`
/// → `Needs clarification`): underscores to spaces, first letter uppercased.
fn humanize(wire: &str) -> String {
    let spaced = wire.replace('_', " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => spaced,
    }
}

/// Build the GitHub issue comment markdown from the STRUCTURED verdict + provenance
/// footer. Pure + deterministic (the `validated_date` is passed in, not read from the
/// clock) so the UI preview and the posted body are byte-identical. `model` and
/// `validated_date` are the run's own (trusted) fields; the verdict fields are
/// model-derived (posted as the user's own reviewed comment).
pub(crate) fn build_issue_comment_body(
    result: &StoredIssueValidationResult,
    model: &str,
    validated_date: &str,
) -> String {
    let mut out = String::new();
    out.push_str("## 🔍 Nightcore issue validation\n\n");
    out.push_str(&format!(
        "**Verdict:** {}  ·  **Kind:** {}  ·  **Confidence:** {}\n\n",
        humanize(&result.verdict),
        humanize(&result.issue_kind),
        humanize(&result.confidence),
    ));

    if !result.reasoning.trim().is_empty() {
        out.push_str(&result.reasoning);
        out.push_str("\n\n");
    }

    // Bug-confirmed line only for bug reports that carry the flag.
    if result.issue_kind == "bug_report" {
        if let Some(confirmed) = result.bug_confirmed {
            out.push_str(&format!(
                "**Bug confirmed:** {}\n\n",
                if confirmed { "Yes" } else { "No" }
            ));
        }
    }

    if let Some(complexity) = &result.estimated_complexity {
        out.push_str(&format!(
            "**Estimated complexity:** {}\n\n",
            humanize(complexity)
        ));
    }

    if !result.related_files.is_empty() {
        out.push_str("**Related files**\n");
        for file in &result.related_files {
            out.push_str(&format!("- `{file}`\n"));
        }
        out.push('\n');
    }

    if let Some(plan) = &result.proposed_plan {
        if !plan.trim().is_empty() {
            out.push_str("**Proposed plan**\n\n");
            out.push_str(plan);
            out.push_str("\n\n");
        }
    }

    if !result.missing_info.is_empty() {
        out.push_str("**Missing information**\n");
        for item in &result.missing_info {
            out.push_str(&format!("- {item}\n"));
        }
        out.push('\n');
    }

    if let Some(pr) = &result.pr_analysis {
        out.push_str("**Linked PR analysis**\n\n");
        if let Some(summary) = &pr.pr_summary {
            if !summary.trim().is_empty() {
                out.push_str(summary);
                out.push_str("\n\n");
            }
        }
        out.push_str(&format!(
            "Recommendation: {}\n\n",
            humanize(&pr.recommendation)
        ));
    }

    out.push_str("---\n");
    out.push_str(&format!(
        "_Validated by Nightcore ({model}, {validated_date}). Automated analysis — treat it as a suggestion._\n"
    ));
    out
}

/// Map a failed comment POST to an actionable message. `gh api` prints GitHub's
/// error-response JSON to STDOUT (stderr carries only `gh: <status>`), so surface the
/// body's `errors[]`/`message` details when present.
fn map_post_failure(binary: &str, out: &GhOutput) -> String {
    let mut msg = map_gh_failure(binary, "api", out);
    if let Ok(v) = serde_json::from_str::<Value>(out.stdout.trim()) {
        let mut details: Vec<String> = v
            .get("errors")
            .and_then(Value::as_array)
            .map(|errs| {
                errs.iter()
                    .filter_map(|e| {
                        e.as_str()
                            .map(str::to_string)
                            .or_else(|| e.get("message")?.as_str().map(str::to_string))
                    })
                    .collect()
            })
            .unwrap_or_default();
        // A top-level `message` (e.g. "Not Found") when there's no `errors[]`.
        if details.is_empty() {
            if let Some(top) = v.get("message").and_then(Value::as_str) {
                details.push(top.to_string());
            }
        }
        if !details.is_empty() {
            msg = format!("{msg}: {}", details.join("; "));
        }
    }
    msg
}

/// Post one issue comment with `body` (production entry point). Returns the created
/// comment's `html_url` when GitHub reports it (best-effort — a missing field is not a
/// failure).
pub(crate) fn post_issue_comment(
    dir: &Path,
    issue_number: u64,
    body: &str,
) -> Result<Option<String>, String> {
    post_issue_comment_with(dir, GH_BINARY, issue_number, body, GH_TIMEOUT)
}

/// Binary-parameterized post — the tests exercise the real spawn + stdin + exit-code
/// mapping with a fake `gh`. Builds `{ "body": <body> }` with serde_json (NEVER string
/// formatting) and POSTs it on STDIN. `issue_number` is a `u64` rendered decimal
/// (injection-safe); `{owner}`/`{repo}` resolve from the repo in `dir`.
pub(super) fn post_issue_comment_with(
    dir: &Path,
    binary: &str,
    issue_number: u64,
    body: &str,
    deadline: Duration,
) -> Result<Option<String>, String> {
    if issue_number == 0 {
        return Err(
            "no issue number to post a comment to (a positive integer is required)".to_string(),
        );
    }
    if body.trim().is_empty() {
        return Err("refusing to post an empty comment".to_string());
    }
    probe_gh(binary, "install it to post issue comments")?;
    // A `serde_json::Value` always serializes; the body rides in the JSON, never argv.
    let payload = json!({ "body": body }).to_string();
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/{issue_number}/comments");
    let out = run_gh_bounded(
        dir,
        binary,
        &["api", "--method", "POST", &endpoint, "--input", "-"],
        Some(&payload),
        deadline,
        "timed out posting the comment to GitHub — check your network and try again",
    )?;
    if !out.status.success() {
        return Err(map_post_failure(binary, &out));
    }
    // GitHub returns the created comment object; surface its html_url (best-effort).
    let url = serde_json::from_str::<Value>(out.stdout.trim())
        .ok()
        .and_then(|v| {
            v.get("html_url")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result() -> StoredIssueValidationResult {
        StoredIssueValidationResult {
            issue_kind: "bug_report".into(),
            verdict: "valid".into(),
            confidence: "high".into(),
            reasoning: "Reproduced: the parser panics on empty input.".into(),
            bug_confirmed: Some(true),
            related_files: vec!["src/parser.rs".into(), "src/lib.rs".into()],
            estimated_complexity: Some("moderate".into()),
            proposed_plan: Some("1. Guard the empty case\n2. Add a regression test".into()),
            missing_info: vec![],
            pr_analysis: None,
        }
    }

    #[test]
    fn format_utc_date_matches_known_epochs() {
        // 2021-01-01T00:00:00Z = 1_609_459_200 s.
        assert_eq!(format_utc_date(1_609_459_200_000), "2021-01-01");
        assert_eq!(format_utc_date(0), "1970-01-01");
    }

    #[test]
    fn humanize_uppercases_and_despaces() {
        assert_eq!(humanize("needs_clarification"), "Needs clarification");
        assert_eq!(humanize("high"), "High");
        assert_eq!(humanize("very_complex"), "Very complex");
    }

    #[test]
    fn body_includes_verdict_reasoning_files_plan_and_footer() {
        let body = build_issue_comment_body(&result(), "claude-opus-4-8", "2026-07-05");
        assert!(body.contains("Nightcore issue validation"), "header");
        assert!(body.contains("**Verdict:** Valid"), "humanized verdict");
        assert!(body.contains("**Kind:** Bug report"), "humanized kind");
        assert!(
            body.contains("**Confidence:** High"),
            "humanized confidence"
        );
        assert!(body.contains("parser panics on empty input"), "reasoning");
        assert!(
            body.contains("**Bug confirmed:** Yes"),
            "bug-confirmed line"
        );
        assert!(
            body.contains("**Estimated complexity:** Moderate"),
            "complexity"
        );
        assert!(
            body.contains("`src/parser.rs`"),
            "related files as code spans"
        );
        assert!(body.contains("Add a regression test"), "proposed plan");
        assert!(
            body.contains("Validated by Nightcore (claude-opus-4-8, 2026-07-05)"),
            "provenance footer with model + date"
        );
    }

    #[test]
    fn body_is_deterministic_for_a_given_date() {
        // The preview-vs-post guarantee: same verdict + model + date ⇒ identical bytes.
        let a = build_issue_comment_body(&result(), "m", "2026-07-05");
        let b = build_issue_comment_body(&result(), "m", "2026-07-05");
        assert_eq!(a, b);
    }

    #[test]
    fn body_omits_bug_confirmed_for_a_feature_request() {
        let mut r = result();
        r.issue_kind = "feature_request".into();
        r.verdict = "valid".into();
        r.bug_confirmed = None;
        let body = build_issue_comment_body(&r, "m", "2026-07-05");
        assert!(
            !body.contains("Bug confirmed"),
            "no bug line for a feature request"
        );
    }

    #[test]
    fn body_renders_missing_info_and_pr_analysis_when_present() {
        let mut r = result();
        r.verdict = "needs_clarification".into();
        r.missing_info = vec!["Which OS?".into(), "A stack trace".into()];
        r.pr_analysis = Some(crate::store::issue_triage::StoredIssuePrAnalysis {
            has_open_pr: true,
            pr_number: Some(9),
            pr_fixes_issue: Some(false),
            pr_summary: Some("PR #9 addresses part of this.".into()),
            recommendation: "pr_needs_work".into(),
        });
        let body = build_issue_comment_body(&r, "m", "2026-07-05");
        assert!(body.contains("**Missing information**"));
        assert!(body.contains("- Which OS?"));
        assert!(body.contains("**Linked PR analysis**"));
        assert!(body.contains("PR #9 addresses part of this."));
        assert!(body.contains("Recommendation: Pr needs work"));
    }

    #[test]
    fn post_rejects_zero_issue_number_and_empty_body_before_spawn() {
        assert!(
            post_issue_comment_with(Path::new("/tmp"), "gh", 0, "x", Duration::from_secs(1))
                .unwrap_err()
                .contains("issue number")
        );
        assert!(
            post_issue_comment_with(Path::new("/tmp"), "gh", 1, "  ", Duration::from_secs(1))
                .unwrap_err()
                .contains("empty comment")
        );
    }
}
