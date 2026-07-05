//! `list_open_prs` — a read-only `gh pr list` for the PR Review config picker, so
//! the user selects a pull request from a list instead of typing its number.
//!
//! Same posture as the rest of the `gh` seam: bounded by a deadline via
//! [`crate::git::gh::run_gh_checked`]; `gh` is the seam and stores no tokens; the repo
//! is the active project's; every text field is gh pass-through (untrusted
//! contributor content) that the web renders as inert text and never feeds to a
//! model. Read-only — no mutation, no lease.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use super::merge::require_project;
use crate::git::gh::{run_gh_checked, GhCall, GH_BINARY, PR_LIST_FIELDS};

const GH_LIST_TIMEOUT: Duration = Duration::from_secs(60);
/// Default cap on the list when the caller passes no limit; the picker also accepts a
/// typed number for PRs beyond it.
const PR_LIST_DEFAULT_LIMIT: u64 = 50;
/// Hard ceiling on a caller-requested limit — a defensive clamp so "load more" can't ask
/// for an unbounded `gh` fetch / IPC payload.
const PR_LIST_MAX_LIMIT: u64 = 200;

/// Resolve the requested list limit: the caller's value clamped to `1..=PR_LIST_MAX_LIMIT`,
/// or the default when omitted (a `Some(0)` clamps up to 1, never a zero-row query). Pure.
fn resolve_limit(limit: Option<u64>) -> u64 {
    limit
        .unwrap_or(PR_LIST_DEFAULT_LIMIT)
        .clamp(1, PR_LIST_MAX_LIMIT)
}

/// One label on a pull request (GitHub-assigned name + 6-hex color, no `#`). The
/// web validates the color before use — never trust it as raw CSS.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrLabel.ts"))]
pub struct PrLabel {
    pub name: String,
    /// 6-hex RGB with no leading `#` (gh vocabulary), or empty.
    pub color: String,
}

/// One open pull request for the PR Review picker. All text fields are gh
/// pass-through (any contributor's content) — inert display / sanitized-markdown
/// only, never a model input, never shell-interpolated.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrSummary.ts"))]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    /// PR lifecycle state (`OPEN`; the list is open-only). gh vocabulary.
    pub state: String,
    /// The PR's head branch name.
    pub head_ref_name: String,
    /// The PR author's GitHub login, or `unknown` when gh omits it.
    pub author: String,
    pub is_draft: bool,
    /// gh-reported ISO-8601 create timestamp; the web formats it locally.
    pub created_at: String,
    /// gh-reported ISO-8601 update timestamp; the web formats it locally.
    pub updated_at: String,
    /// The gh-reported PR page URL (https), for "open on GitHub". Never a raw git
    /// remote URL (which can embed credentials).
    pub url: String,
    pub labels: Vec<PrLabel>,
    /// The PR description (untrusted markdown) — the web renders it through the
    /// SANITIZING `Markdown` primitive, never raw.
    pub body: String,
    /// Total lines added across the PR (gh vocabulary), for a size badge. `0` when gh
    /// omits it.
    pub additions: u32,
    /// Total lines removed across the PR (gh vocabulary), for a size badge. `0` when gh
    /// omits it.
    pub deletions: u32,
}

/// The `gh pr list --json` row shape. Everything beyond `number` is optional with
/// a safe default, so gh field/vocabulary drift degrades a row — never the list.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPrListItem {
    number: u64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    head_ref_name: Option<String>,
    #[serde(default)]
    author: Option<GhAuthor>,
    #[serde(default)]
    is_draft: Option<bool>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    labels: Vec<GhLabel>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    additions: Option<u32>,
    #[serde(default)]
    deletions: Option<u32>,
}

#[derive(Debug, serde::Deserialize)]
struct GhAuthor {
    #[serde(default)]
    login: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GhLabel {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
}

impl GhPrListItem {
    fn into_summary(self) -> PrSummary {
        PrSummary {
            number: self.number,
            title: self.title.unwrap_or_default(),
            state: self.state.unwrap_or_else(|| "OPEN".to_string()),
            head_ref_name: self.head_ref_name.unwrap_or_default(),
            author: self
                .author
                .and_then(|a| a.login)
                .unwrap_or_else(|| "unknown".to_string()),
            is_draft: self.is_draft.unwrap_or(false),
            created_at: self.created_at.unwrap_or_default(),
            updated_at: self.updated_at.unwrap_or_default(),
            url: self.url.unwrap_or_default(),
            labels: self
                .labels
                .into_iter()
                .map(|l| PrLabel {
                    name: l.name.unwrap_or_default(),
                    color: l.color.unwrap_or_default(),
                })
                .collect(),
            body: self.body.unwrap_or_default(),
            additions: self.additions.unwrap_or(0),
            deletions: self.deletions.unwrap_or(0),
        }
    }
}

/// Parse `gh pr list --json` stdout into the wire contract. Pure + unit-tested.
/// An empty body (no open PRs) is a clean empty list, not an error.
fn parse_pr_list(stdout: &str) -> Result<Vec<PrSummary>, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let items: Vec<GhPrListItem> = serde_json::from_str(trimmed)
        .map_err(|e| format!("could not parse gh pr list output: {e}"))?;
    Ok(items.into_iter().map(GhPrListItem::into_summary).collect())
}

/// The bounded seam — `binary`-parameterized so tests inject a fake `gh`. `limit` is the
/// already-resolved (clamped) row cap.
fn list_open_prs_with(
    dir: &Path,
    binary: &str,
    limit: u64,
    deadline: Duration,
) -> Result<Vec<PrSummary>, String> {
    let limit_arg = limit.to_string();
    let stdout = run_gh_checked(GhCall {
        dir,
        binary,
        args: &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            &limit_arg,
            "--json",
            PR_LIST_FIELDS,
        ],
        action: "install it to list pull requests",
        subcmd: "pr list",
        stdin: None,
        deadline,
        timeout_msg: "timed out listing pull requests — check your network and try again",
    })?;
    parse_pr_list(&stdout)
}

fn list_open_prs_blocking(app: &AppHandle, limit: u64) -> Result<Vec<PrSummary>, String> {
    let project = require_project(app)?;
    let dir = std::path::PathBuf::from(&project.path);
    list_open_prs_with(&dir, GH_BINARY, limit, GH_LIST_TIMEOUT)
}

/// List the active project's open pull requests for the PR Review picker. Runs off
/// the UI thread (the network `gh` spawn must not block the WKWebView). `limit` is
/// OPTIONAL (the web may omit it): defaults to [`PR_LIST_DEFAULT_LIMIT`] and clamps to
/// `1..=PR_LIST_MAX_LIMIT` so "load more" stays bounded.
#[tauri::command]
pub async fn list_open_prs(app: AppHandle, limit: Option<u64>) -> Result<Vec<PrSummary>, String> {
    let limit = resolve_limit(limit);
    tauri::async_runtime::spawn_blocking(move || list_open_prs_blocking(&app, limit))
        .await
        .map_err(|e| format!("list pull requests failed to run: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pr_list_flattens_author_labels_and_defaults_missing_fields() {
        let json = r#"[
            {"number": 42, "title": "Fix the thing", "state": "OPEN", "headRefName": "nc/fix",
             "author": {"login": "alice"}, "isDraft": false, "createdAt": "2026-07-01T09:00:00Z",
             "updatedAt": "2026-07-02T10:00:00Z", "url": "https://github.com/o/r/pull/42",
             "labels": [{"name": "bug", "color": "d73a4a"}, {"name": "p2", "color": "fbca04"}],
             "body": "Repro steps here", "additions": 120, "deletions": 34},
            {"number": 41, "author": null}
        ]"#;
        let prs = parse_pr_list(json).expect("parses");
        assert_eq!(prs.len(), 2);
        assert_eq!(prs[0].number, 42);
        assert_eq!(prs[0].author, "alice");
        assert_eq!(prs[0].head_ref_name, "nc/fix");
        assert!(!prs[0].is_draft);
        assert_eq!(prs[0].url, "https://github.com/o/r/pull/42");
        assert_eq!(prs[0].body, "Repro steps here");
        assert_eq!(prs[0].labels.len(), 2);
        assert_eq!(prs[0].labels[0].name, "bug");
        assert_eq!(prs[0].labels[0].color, "d73a4a");
        assert_eq!((prs[0].additions, prs[0].deletions), (120, 34));
        // A row missing everything but `number` degrades gracefully, not drops.
        assert_eq!(prs[1].number, 41);
        assert_eq!(prs[1].author, "unknown");
        assert_eq!(prs[1].title, "");
        assert_eq!(prs[1].state, "OPEN"); // defaulted
        assert!(prs[1].labels.is_empty());
        assert_eq!(
            (prs[1].additions, prs[1].deletions),
            (0, 0),
            "absent line deltas degrade to zero"
        );
    }

    #[test]
    fn resolve_limit_defaults_and_clamps() {
        assert_eq!(
            resolve_limit(None),
            PR_LIST_DEFAULT_LIMIT,
            "omitted ⇒ default"
        );
        assert_eq!(
            resolve_limit(Some(100)),
            100,
            "an in-range value passes through"
        );
        assert_eq!(
            resolve_limit(Some(0)),
            1,
            "zero clamps up to one (never a 0-row query)"
        );
        assert_eq!(
            resolve_limit(Some(10_000)),
            PR_LIST_MAX_LIMIT,
            "an over-ceiling value clamps to the max"
        );
    }

    #[test]
    fn parse_pr_list_empty_output_is_an_empty_list() {
        assert_eq!(parse_pr_list("").expect("ok"), Vec::new());
        assert_eq!(parse_pr_list("   \n").expect("ok"), Vec::new());
        assert_eq!(parse_pr_list("[]").expect("ok"), Vec::new());
    }

    #[test]
    fn parse_pr_list_malformed_json_is_an_error_not_a_panic() {
        assert!(parse_pr_list("not json").is_err());
        assert!(parse_pr_list("{\"number\":1}").is_err()); // object, not an array
    }

    /// Write an executable shell script to stand in for `gh` (the phase-1/3/4 fixture
    /// pattern), exercising the real spawn + exit-code mapping.
    #[cfg(unix)]
    fn fake_gh(dir: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-gh.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
        let mut perms = std::fs::metadata(&path).expect("meta").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod");
        path
    }

    #[test]
    #[cfg(unix)]
    fn list_open_prs_with_requests_open_state_and_the_json_fields() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "printf '%s\\n' \"$@\" >> args.txt\n\
             printf '[{\"number\":7,\"title\":\"t\",\"state\":\"OPEN\",\"headRefName\":\"b\",\"author\":{\"login\":\"bob\"},\"isDraft\":true,\"createdAt\":\"c\",\"updatedAt\":\"x\",\"url\":\"https://gh/7\",\"labels\":[],\"body\":\"desc\",\"additions\":5,\"deletions\":2}]'\n\
             exit 0",
        );
        let prs = list_open_prs_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            75,
            GH_LIST_TIMEOUT,
        )
        .expect("list succeeds");
        assert_eq!(
            prs,
            vec![PrSummary {
                number: 7,
                title: "t".into(),
                state: "OPEN".into(),
                head_ref_name: "b".into(),
                author: "bob".into(),
                is_draft: true,
                created_at: "c".into(),
                updated_at: "x".into(),
                url: "https://gh/7".into(),
                labels: vec![],
                body: "desc".into(),
                additions: 5,
                deletions: 2,
            }]
        );
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args");
        assert!(args.contains("list"), "invokes `gh pr list`");
        assert!(args.contains("--state\nopen"), "requests only open PRs");
        assert!(args.contains(PR_LIST_FIELDS), "asks for the picker fields");
        assert!(
            args.contains("--limit\n75"),
            "passes the resolved row limit"
        );
    }

    #[test]
    #[cfg(unix)]
    fn list_open_prs_with_surfaces_stderr_verbatim_on_failure() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "echo 'gh: no default remote repository' 1>&2\nexit 1",
        );
        let err = list_open_prs_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            50,
            GH_LIST_TIMEOUT,
        )
        .expect_err("a failing gh is an error");
        assert!(err.contains("no default remote repository"));
    }
}
