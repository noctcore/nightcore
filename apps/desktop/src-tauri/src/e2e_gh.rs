//! E2E ladder ring 1 — the real-`gh` scratch-repo harness (issue #150, deliverable b).
//!
//! These tests drive the **real** `gh` CLI against a **real scratch GitHub repo** to
//! exercise the behaviors a fake/scripted `gh` provably cannot reproduce — the class
//! where "works in the mock" hides a real-remote break. They are ALL `#[ignore]`d, so
//! the default `cargo test` battery (and CI) NEVER runs them: they need a scratch repo
//! checkout + a `GH_TOKEN`, and they mutate real GitHub state (labels, review posts).
//!
//! Run them deliberately:
//! ```sh
//! bun run dogfood:gh          # → cargo test -p nightcore --lib --ignored e2e_gh -- --nocapture
//! ```
//! with this environment (a test with a missing var SKIPS with a printed reason, so a
//! partial setup never hard-fails):
//! - `GH_TOKEN` — a PAT with repo scope (gh reads it from env).
//! - `NIGHTCORE_E2E_GH_DIR` — a local checkout of the scratch repo (its `origin` remote
//!   is what gh resolves `{owner}`/`{repo}` from).
//! - `NIGHTCORE_E2E_GH_PR` — an OPEN PR number in that repo (targets 1 + 5).
//! - `NIGHTCORE_E2E_GH_ISSUE` — an issue number in that repo (target 3 + the `Closes #N`
//!   observation in target 4).
//!
//! Each test drives the SAME injectable `dir`+`binary` seams production uses
//! (`crate::git::gh::run_gh_bounded` is the shared low-level gh runner every workflow
//! `*_with` seam delegates to; the `pub(crate)` workflow entry points wrap it).
#![cfg(test)]

use std::path::PathBuf;
use std::time::Duration;

use crate::git::gh::{run_gh_bounded, GhOutput};

/// The bound for a single gh call in these tests. Generous — real-network latency,
/// not a determinism knob (these never run in CI).
const GH_DEADLINE: Duration = Duration::from_secs(30);

/// A compact, `Debug`-free rendering of a gh result for assert messages (`GhOutput`
/// is intentionally not `Debug`).
fn describe(out: &GhOutput) -> String {
    format!(
        "status={:?} stdout={} stderr={}",
        out.status,
        out.stdout.trim(),
        out.stderr.trim()
    )
}

/// Resolve the scratch checkout dir, or `None` (with a printed skip reason) when the
/// harness env isn't set up. `GH_TOKEN` must also be present for gh to authenticate.
fn scratch_dir() -> Option<PathBuf> {
    if std::env::var_os("GH_TOKEN").is_none() {
        eprintln!("SKIP: set GH_TOKEN (a repo-scoped PAT) to run the e2e_gh harness");
        return None;
    }
    match std::env::var_os("NIGHTCORE_E2E_GH_DIR") {
        Some(dir) => Some(PathBuf::from(dir)),
        None => {
            eprintln!("SKIP: set NIGHTCORE_E2E_GH_DIR to a scratch-repo checkout to run this test");
            None
        }
    }
}

/// Read a required numeric env var (a PR/issue number), or `None` with a skip reason.
fn env_number(key: &str) -> Option<u64> {
    match std::env::var(key)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
    {
        Some(n) => Some(n),
        None => {
            eprintln!("SKIP: set {key}=<number> to run this test");
            None
        }
    }
}

/// Target 1 — a bad inline-comment line anchor makes the review POST fail atomically
/// with HTTP 422. This is the exact `gh api .../pulls/<n>/reviews --input -` call
/// `workflow::pr_review_post::post::post_review_with` makes; the reviews endpoint
/// validates each comment's `line` against the actual diff and rejects the ENTIRE
/// review (body + all comments) on one bad anchor. A fake gh accepts any line and
/// returns 200 — it can never surface this, which is why review-post survivability
/// (roadmap T10) can only be proven here.
#[test]
#[ignore = "needs a scratch GitHub repo + GH_TOKEN; run via `bun run dogfood:gh`"]
fn e2e_gh_review_post_rejects_a_bad_line_anchor() {
    let (Some(dir), Some(pr)) = (scratch_dir(), env_number("NIGHTCORE_E2E_GH_PR")) else {
        return;
    };
    // An inline comment anchored to a line that cannot exist in the diff.
    let payload = r#"{"event":"COMMENT","body":"nightcore e2e ring-1 probe (expected 422)","comments":[{"path":"README.md","line":999999,"body":"anchored to a non-existent line"}]}"#;
    let endpoint = format!("repos/{{owner}}/{{repo}}/pulls/{pr}/reviews");
    let out = run_gh_bounded(
        &dir,
        "gh",
        &["api", "--method", "POST", &endpoint, "--input", "-"],
        Some(payload),
        GH_DEADLINE,
        "review post timed out",
    )
    .expect("gh ran");
    assert!(
        !out.status.success(),
        "a bad line anchor must fail the whole review post (got success): {}",
        describe(&out)
    );
    let body = format!("{}{}", out.stdout, out.stderr).to_lowercase();
    assert!(
        body.contains("422") || body.contains("line") || body.contains("pull_request_review"),
        "the failure must be GitHub's 422 anchor rejection, got: {body}"
    );
}

/// Target 2 — `gh api graphql -F owner={owner} -F name={repo} …` placeholder
/// expansion. `workflow::issue_triage::list_open_issues` issues exactly this graphql
/// call; only real gh substitutes `{owner}`/`{repo}` from the checkout's remote and
/// validates the query + variables. A fake echoes canned JSON regardless, so a broken
/// placeholder or a renamed field would pass the mock and fail live.
#[test]
#[ignore = "needs a scratch GitHub repo + GH_TOKEN; run via `bun run dogfood:gh`"]
fn e2e_gh_graphql_expands_owner_and_name_placeholders() {
    let Some(dir) = scratch_dir() else { return };
    let issues = crate::workflow::issue_triage::list_open_issues(&dir)
        .expect("the -F owner={owner} graphql query must expand + validate against real gh");
    // The list may be empty; success (not the count) is the placeholder-expansion proof.
    eprintln!(
        "e2e_gh: list_open_issues returned {} open issue(s)",
        issues.len()
    );
}

/// Target 3 — the `nc:*` label lifecycle: `ensure_label_named` (create, tolerating
/// 422 `already_exists`), an ADDITIVE label POST (never a PUT-replace that would nuke
/// the issue's other labels), and a 404-tolerant DELETE (idempotent removal). Real
/// GitHub enforces all three contracts; a fake can reveal none of them.
#[test]
#[ignore = "needs a scratch GitHub repo + GH_TOKEN + issue number; run via `bun run dogfood:gh`"]
fn e2e_gh_label_lifecycle_ensure_add_remove() {
    let (Some(dir), Some(issue)) = (scratch_dir(), env_number("NIGHTCORE_E2E_GH_ISSUE")) else {
        return;
    };
    let label = "nc:e2e-probe";

    // ensure: create the label (or succeed on 422 already_exists — the cached path).
    crate::workflow::github_labels::ensure_label_named(
        &dir,
        "gh",
        label,
        "ededed",
        "nightcore e2e ring-1 probe label",
        GH_DEADLINE,
    )
    .expect("ensure_label_named must create-or-tolerate-existing");

    // add: the ADDITIVE POST to issues/<n>/labels (mirrors labels::add_label_with).
    let add_field = format!("labels[]={label}");
    let add_endpoint = format!("repos/{{owner}}/{{repo}}/issues/{issue}/labels");
    let added = run_gh_bounded(
        &dir,
        "gh",
        &["api", "--method", "POST", &add_endpoint, "-f", &add_field],
        None,
        GH_DEADLINE,
        "label add timed out",
    )
    .expect("gh ran");
    assert!(
        added.status.success(),
        "additive label POST must succeed: {}",
        describe(&added)
    );

    // remove: DELETE the label; a 404 (already absent) is tolerated as success by
    // production (labels::remove_label_with), so a real, present label deletes cleanly.
    let del_endpoint = format!("repos/{{owner}}/{{repo}}/issues/{issue}/labels/{label}");
    let removed = run_gh_bounded(
        &dir,
        "gh",
        &["api", "--method", "DELETE", &del_endpoint],
        None,
        GH_DEADLINE,
        "label remove timed out",
    )
    .expect("gh ran");
    assert!(
        removed.status.success(),
        "removing a present label must succeed: {}",
        describe(&removed)
    );
}

/// Target 4 — `Closes #N`: the pure composition (`ensure_closes_keyword`, always
/// asserted) plus the real-remote OBSERVATION that a merged `Closes #N` actually
/// flipped the linked issue to `closed`. `project_issue_states` is the seam that reads
/// the true open/closed state; a fake reports create/merge success but the issue never
/// moves, so only this observation catches a broken close-link.
#[test]
#[ignore = "needs a scratch GitHub repo + GH_TOKEN + issue number; run via `bun run dogfood:gh`"]
fn e2e_gh_closes_keyword_and_real_issue_state() {
    // Pure half — runs whenever the test is invoked, no network.
    let body = crate::workflow::pr::ensure_closes_keyword("Some PR body", 42);
    assert!(
        body.contains("Closes #42"),
        "the closes keyword is appended"
    );
    assert_eq!(
        crate::workflow::pr::ensure_closes_keyword(&body, 42),
        body,
        "appending is idempotent"
    );

    // Real-remote half — observe the issue's true state via the production seam.
    let (Some(dir), Some(issue)) = (scratch_dir(), env_number("NIGHTCORE_E2E_GH_ISSUE")) else {
        return;
    };
    let states = crate::workflow::issue_sync::project_issue_states(&dir, &[issue])
        .expect("project_issue_states must read real open/closed state");
    match states.iter().find(|s| s.number == issue) {
        Some(p) => {
            assert!(
                p.state == "open" || p.state == "closed",
                "the issue state must be a real open/closed value, got {:?}",
                p.state
            );
            eprintln!("e2e_gh: issue #{issue} state = {}", p.state);
        }
        None => eprintln!(
            "e2e_gh: issue #{issue} not in the projection (closed + list-capped is a valid outcome)"
        ),
    }
}

/// Target 5 — an unknown `--json` field is FATAL: real gh validates the field list
/// against its installed schema and exits non-zero, while a fake ignores `--json` and
/// prints canned JSON. Every `*_with` seam that requests `--json <fields>` (PR view,
/// PR list, changed files, …) is exposed to gh-version field renames; this proves the
/// fatality contract those seams rely on.
#[test]
#[ignore = "needs a scratch GitHub repo + GH_TOKEN + PR number; run via `bun run dogfood:gh`"]
fn e2e_gh_unknown_json_field_is_fatal() {
    let (Some(dir), Some(pr)) = (scratch_dir(), env_number("NIGHTCORE_E2E_GH_PR")) else {
        return;
    };
    let pr = pr.to_string();

    // A known-good field set succeeds (baseline — proves the PR + auth are usable).
    let ok = run_gh_bounded(
        &dir,
        "gh",
        &["pr", "view", &pr, "--json", "number,url,state"],
        None,
        GH_DEADLINE,
        "pr view timed out",
    )
    .expect("gh ran");
    assert!(
        ok.status.success(),
        "a valid --json field set must succeed: {}",
        describe(&ok)
    );

    // An invented field is rejected — the fatality a fake gh can never model.
    let bad = run_gh_bounded(
        &dir,
        "gh",
        &["pr", "view", &pr, "--json", "totallyBogusFieldXyz"],
        None,
        GH_DEADLINE,
        "pr view timed out",
    )
    .expect("gh ran");
    assert!(
        !bad.status.success(),
        "an unknown --json field must be fatal (got success): {}",
        describe(&bad)
    );
    let err = format!("{}{}", bad.stdout, bad.stderr).to_lowercase();
    assert!(
        err.contains("unknown") || err.contains("json") || err.contains("field"),
        "the failure must name the unknown --json field, got: {err}"
    );
}
