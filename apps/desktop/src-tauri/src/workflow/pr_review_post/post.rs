//! The terminal post seam: build one atomic GitHub review
//! (`{event, body, comments[]}`) with serde_json (never string formatting) and
//! POST it via `gh api …/reviews --input -`, body on STDIN. The human gate lives
//! on the web side; here we just do the work.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::GH_TIMEOUT;
use crate::store::pr_review::PrReviewStore;
use crate::store::TaskStore;
use crate::task::now_ms;
use crate::workflow::merge::require_project;
use crate::git::gh::{map_gh_failure, probe_gh, run_gh_bounded, GhOutput, GH_BINARY};

/// The GitHub review verdict, mapped to the `gh` API `event` enum. The web sends the
/// kebab form (`approve` / `request-changes` / `comment`); the uppercase `gh` forms are
/// accepted defensively. Any other value is rejected.
pub(super) fn review_event(verdict: &str) -> Result<&'static str, String> {
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

/// Build the `gh api …/reviews` JSON payload with serde_json (NEVER string formatting):
/// `{ event, body, comments: [{path, line, body}, …] }`. Pure, unit-testable.
pub(super) fn build_review_payload(event: &str, body: &str, comments: &[InlineComment]) -> String {
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
pub(super) fn post_review_with(
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
    probe_gh(binary, "install it to post pull-request reviews")?;
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
        return Err(map_post_review_failure(binary, event, &out));
    }
    Ok(())
}

/// Map a failed review POST to an actionable message. `gh api` prints GitHub's
/// error-response JSON to STDOUT — stderr carries only `gh: <status> (HTTP <n>)` —
/// and for review posts the real reason lives in that body's `errors[]` (an inline
/// anchor outside the diff, the own-PR rule, …). Surface those details, and when a
/// 422 arrives with no detail on a non-COMMENT verdict, spell out the documented
/// rule the bare status hides: GitHub refuses APPROVE / REQUEST_CHANGES reviews on
/// a pull request you authored (COMMENT is allowed).
pub(super) fn map_post_review_failure(binary: &str, event: &str, out: &GhOutput) -> String {
    let mut msg = map_gh_failure(binary, "api", out);
    let details: Vec<String> = serde_json::from_str::<Value>(out.stdout.trim())
        .ok()
        .and_then(|v| {
            v.get("errors")?.as_array().map(|errs| {
                errs.iter()
                    .filter_map(|e| {
                        // GitHub mixes plain strings and `{message}` objects in `errors[]`.
                        e.as_str()
                            .map(str::to_string)
                            .or_else(|| e.get("message")?.as_str().map(str::to_string))
                    })
                    .collect()
            })
        })
        .unwrap_or_default();
    if !details.is_empty() {
        msg = format!("{msg}: {}", details.join("; "));
    } else if msg.contains("HTTP 422") && event != "COMMENT" {
        msg.push_str(
            " — GitHub refuses approve/request-changes reviews on a pull request \
             you authored; post this review as a comment instead",
        );
    }
    msg
}

/// Post a Nightcore-composed review to a GitHub pull request of the active project. The
/// human gate lives on the web side (a ConfirmDialog); here we just do the work. The
/// `body` + comment text are OUR OWN findings (trusted); this never echoes raw foreign
/// diff text. Runs off the UI thread (the network `gh` spawn must not block the WKWebView).
///
/// `run_id` is the OPTIONAL originating PR-review run: when present, a successful post
/// stamps that run's `postedVerdict`/`postedAt` (best-effort — the web may omit it, e.g.
/// a post composed outside a stored run).
#[tauri::command]
pub async fn post_review_to_github(
    app: AppHandle,
    pr_number: u64,
    verdict: String,
    body: String,
    comments: Vec<InlineComment>,
    run_id: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        post_review_blocking(
            &app,
            pr_number,
            &verdict,
            &body,
            &comments,
            run_id.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("post review failed to run: {e}"))?
}

/// The blocking body of [`post_review_to_github`]: resolve the active project (its root
/// is the `gh` cwd, which resolves `{owner}`/`{repo}`), post, then (on success) stamp the
/// originating run's posted marker.
fn post_review_blocking(
    app: &AppHandle,
    pr_number: u64,
    verdict: &str,
    body: &str,
    comments: &[InlineComment],
    run_id: Option<&str>,
) -> Result<(), String> {
    // Touch the task store so a mis-wired managed state surfaces here rather than as a
    // confusing gh failure (parity with the sibling PR commands' state discipline).
    let _ = app.try_state::<TaskStore>();
    let project = require_project(app)?;
    let dir = std::path::PathBuf::from(&project.path);
    tracing::info!(target: "nightcore::pr", pr_number, verdict, comments = comments.len(), "posting PR review to GitHub");
    post_review_with(
        &dir, GH_BINARY, pr_number, verdict, body, comments, GH_TIMEOUT,
    )?;

    // The post SUCCEEDED — record it on the originating run so the UI shows what was last
    // posted. Best-effort: a missing run id, unavailable store, or unknown run must not
    // turn a succeeded post into a failure, so any problem is warned, never propagated.
    if let Some(run_id) = run_id {
        stamp_posted(app, run_id, verdict);
    }
    Ok(())
}

/// Best-effort stamp of a successful post onto its PR-review run (`postedVerdict` +
/// `postedAt`). Never returns an error: staleness/posted markers are additive UI signals,
/// and the post has already landed on GitHub — a store hiccup must not surface as a
/// (misleading) post failure.
fn stamp_posted(app: &AppHandle, run_id: &str, verdict: &str) {
    let Some(store) = app.try_state::<PrReviewStore>() else {
        tracing::warn!(target: "nightcore::pr", run_id, "PR review store unavailable — posted marker not recorded");
        return;
    };
    if let Err(e) = store.mutate(run_id, |run| {
        run.posted_verdict = Some(verdict.to_string());
        run.posted_at = Some(now_ms());
    }) {
        tracing::warn!(target: "nightcore::pr", run_id, error = %e, "failed to record posted marker (post already succeeded)");
    }
}
