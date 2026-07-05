//! The pushed-fix SUMMARY COMMENT: after a human-gated `push_pr_fix`, optionally
//! post one markdown comment on the PR explaining how the fix addressed its
//! targets (the Aperant-style close-the-loop note reviewers see next to the new
//! commit).
//!
//! Trust posture: the comment body embeds the fix session's summary — MODEL
//! text — verbatim. That is deliberate and HUMAN-GATED twice over: the summary
//! is displayed in the fix card before the push, and the push dialog's
//! "post a summary comment" checkbox is the explicit opt-in that sends it. The
//! payload is built with serde_json (never string-formatted JSON) and posted via
//! `gh api … --input -` with the body on STDIN, the PR-arc rule.

use std::path::Path;
use std::time::Duration;

use serde_json::json;

use super::state::{PrFixState, KIND_CI, KIND_CONFLICTS};
use crate::git::gh::{run_gh_checked, GhCall};

/// Wall-clock bound on the comment POST (one small write).
pub(super) const GH_COMMENT_TIMEOUT: Duration = Duration::from_secs(60);

/// Defensive cap on the embedded summary (GitHub's comment limit is 64K; a
/// summary anywhere near this is a runaway log dump, not prose).
const SUMMARY_MAX_CHARS: usize = 16_000;

/// Compose the pushed-fix comment markdown: a kind-aware header, the what/where
/// line (targets, branch, commit), the session's summary verbatim, and the
/// Nightcore footer (the `composeReviewBody` house style).
pub(super) fn compose_push_comment(state: &PrFixState, short_sha: Option<&str>) -> String {
    let (title, noun) = match state.kind.as_str() {
        KIND_CI => ("CI fixes pushed", "failing check"),
        KIND_CONFLICTS => ("merge conflicts resolved", "conflicted file"),
        _ => ("review fixes pushed", "review finding"),
    };
    let mut lines: Vec<String> = vec![format!("### 🌙 Nightcore — {title}"), String::new()];

    let mut what = if state.finding_count > 0 {
        format!(
            "Addressed **{}** {noun}{} on `{}`",
            state.finding_count,
            if state.finding_count == 1 { "" } else { "s" },
            state.branch
        )
    } else {
        format!("Pushed to `{}`", state.branch)
    };
    if let Some(sha) = short_sha {
        // Bare short shas autolink in GitHub comments (backticks would defeat it).
        what.push_str(&format!(" — head {sha}"));
    }
    what.push('.');
    lines.push(what);

    if let Some(summary) = state.summary.as_deref() {
        let trimmed = summary.trim();
        if !trimmed.is_empty() {
            lines.push(String::new());
            if trimmed.chars().count() > SUMMARY_MAX_CHARS {
                let capped: String = trimmed.chars().take(SUMMARY_MAX_CHARS).collect();
                lines.push(capped);
                lines.push(String::new());
                lines.push("_(summary truncated)_".to_string());
            } else {
                lines.push(trimmed.to_string());
            }
        }
    }

    lines.push(String::new());
    lines.push("---".to_string());
    lines.push("_Posted from Nightcore._".to_string());
    lines.join("\n")
}

/// The checkout's HEAD short sha (what the push just published), for the
/// comment's autolinking commit reference. Best-effort — `None` never blocks
/// the comment.
pub(super) fn head_short_sha(dir: &Path) -> Option<String> {
    crate::git::run::git_stdout(dir, &["rev-parse", "--short=10", "HEAD"]).filter(|s| !s.is_empty())
}

/// POST one issue comment on the PR via `gh api … --input -` (the issues
/// endpoint is how PR conversation comments are written). Binary-parameterized
/// — the fake-`gh` test seam.
pub(super) fn post_push_comment_with(
    dir: &Path,
    binary: &str,
    pr_number: u64,
    body: &str,
    deadline: Duration,
) -> Result<(), String> {
    let payload = json!({ "body": body }).to_string();
    let endpoint = format!("repos/{{owner}}/{{repo}}/issues/{pr_number}/comments");
    run_gh_checked(GhCall {
        dir,
        binary,
        args: &["api", "--method", "POST", &endpoint, "--input", "-"],
        action: "install it to post the summary comment",
        subcmd: "api",
        stdin: Some(&payload),
        deadline,
        timeout_msg: "timed out posting the summary comment to GitHub",
    })?;
    Ok(())
}
