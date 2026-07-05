//! Fetch ONE issue's body + first page of comments via `gh api graphql`.
//!
//! The detail-panel data source (design §UX flow 2). Capped to the first page of
//! comments — full comment-thread pagination is an explicit non-goal. Returns
//! [`IssueDetail`], the Rust-seam shape the web casts (body + comments), reusing the
//! contract [`crate::contracts::IssueComment`] for each comment (its exact
//! `{id, author, body, createdAt}` camelCase shape). Every field is untrusted.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{
    cap_text, errors_first, GqlAuthor, GqlNodes, GraphQlResponse, ISSUE_BODY_MAX_LEN,
    ISSUE_COMMENTS_MAX, ISSUE_COMMENT_BODY_MAX_LEN,
};
use crate::contracts::IssueComment;
use crate::git::gh::{map_gh_failure, probe_gh, run_gh_bounded, GH_BINARY};

/// One issue's detail: its (capped) body plus the first page of (capped) comments. The
/// Rust-seam shape the web casts; NOT part of the engine NDJSON protocol.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    /// The issue markdown (untrusted; capped).
    pub body: String,
    /// The first page of comments (capped count + per-body cap).
    pub comments: Vec<IssueComment>,
}

/// Single line — `gh` sends it verbatim. `$number` is typed Int via `-F`.
const GRAPHQL_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){body comments(first:100){nodes{id author{login} body createdAt}}}}}";

#[derive(Debug, Deserialize)]
struct Data {
    #[serde(default)]
    repository: Option<Repository>,
}

#[derive(Debug, Deserialize)]
struct Repository {
    #[serde(default)]
    issue: Option<GqlIssue>,
}

#[derive(Debug, Deserialize)]
struct GqlIssue {
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    comments: GqlNodes<GqlComment>,
}

#[derive(Debug, Deserialize)]
struct GqlComment {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    author: Option<GqlAuthor>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default, rename = "createdAt")]
    created_at: Option<String>,
}

/// Parse a `gh api graphql` issue-detail payload into [`IssueDetail`] (PURE —
/// unit-tested): errors[]-FIRST, then a null `issue` is a not-found, then the body +
/// comments are capped. A comment missing its `id` is dropped (it can't be keyed).
pub(super) fn parse_issue_detail(stdout: &str) -> Result<IssueDetail, String> {
    let response: GraphQlResponse<Data> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("`gh api graphql` returned unparseable JSON: {e}"))?;
    errors_first(&response.errors, "issue-detail query")?;

    let issue = response
        .data
        .and_then(|d| d.repository)
        .and_then(|r| r.issue)
        .ok_or_else(|| "the issue was not found on GitHub".to_string())?;

    let comments: Vec<IssueComment> = issue
        .comments
        .nodes
        .into_iter()
        .filter_map(|c| {
            Some(IssueComment {
                id: c.id?,
                author: GqlAuthor::login_or_unknown(c.author),
                body: cap_text(c.body.unwrap_or_default(), ISSUE_COMMENT_BODY_MAX_LEN),
                created_at: c.created_at.unwrap_or_default(),
            })
        })
        .take(ISSUE_COMMENTS_MAX)
        .collect();

    Ok(IssueDetail {
        body: cap_text(issue.body.unwrap_or_default(), ISSUE_BODY_MAX_LEN),
        comments,
    })
}

/// Production entry point: fetch issue `number`'s body + comments in `dir`.
pub(crate) fn fetch_issue_detail(dir: &Path, number: u64) -> Result<IssueDetail, String> {
    fetch_issue_detail_with(dir, GH_BINARY, number, super::GH_TIMEOUT)
}

/// Binary-parameterized detail fetch — the fake-`gh` injection seam. `number` is a
/// `u64` rendered decimal (injection-safe).
pub(super) fn fetch_issue_detail_with(
    dir: &Path,
    binary: &str,
    number: u64,
    deadline: Duration,
) -> Result<IssueDetail, String> {
    if number == 0 {
        return Err("enter a valid issue number (a positive integer)".to_string());
    }
    probe_gh(binary, "install it to read issues")?;
    let number_arg = format!("number={number}");
    let query_arg = format!("query={GRAPHQL_QUERY}");
    let out = run_gh_bounded(
        dir,
        binary,
        &[
            "api",
            "graphql",
            "-F",
            "owner={owner}",
            "-F",
            "name={repo}",
            "-F",
            &number_arg,
            "-f",
            &query_arg,
        ],
        None,
        deadline,
        "timed out reading the issue from GitHub — check your network and try again",
    )?;
    if !out.status.success() {
        return Err(map_gh_failure(binary, "api graphql", &out));
    }
    parse_issue_detail(&out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_body_and_comments() {
        let payload = serde_json::json!({
            "data": { "repository": { "issue": {
                "body": "It crashes.",
                "comments": { "nodes": [
                    { "id": "IC_1", "author": { "login": "bob" }, "body": "me too", "createdAt": "2026-07-02T00:00:00Z" },
                    { "id": "IC_2", "author": null, "body": null, "createdAt": null }
                ] }
            } } }
        })
        .to_string();
        let detail = parse_issue_detail(&payload).expect("parse");
        assert_eq!(detail.body, "It crashes.");
        assert_eq!(detail.comments.len(), 2);
        assert_eq!(detail.comments[0].author, "bob");
        assert_eq!(
            detail.comments[1].author, "unknown",
            "ghost author degrades"
        );
        assert_eq!(detail.comments[1].body, "", "null body degrades to empty");
    }

    #[test]
    fn a_comment_without_an_id_is_dropped() {
        let payload = serde_json::json!({
            "data": { "repository": { "issue": {
                "body": "b", "comments": { "nodes": [ { "author": { "login": "x" }, "body": "no id" } ] }
            } } }
        })
        .to_string();
        let detail = parse_issue_detail(&payload).expect("parse");
        assert!(
            detail.comments.is_empty(),
            "a comment with no id can't be keyed"
        );
    }

    #[test]
    fn errors_array_takes_precedence() {
        let payload = serde_json::json!({
            "data": null, "errors": [{ "message": "Something went wrong" }]
        })
        .to_string();
        let err = parse_issue_detail(&payload).unwrap_err();
        assert!(err.contains("Something went wrong"));
    }

    #[test]
    fn null_issue_is_a_not_found() {
        let payload =
            serde_json::json!({ "data": { "repository": { "issue": null } } }).to_string();
        assert!(parse_issue_detail(&payload)
            .unwrap_err()
            .contains("not found"));
    }

    #[test]
    fn number_zero_is_rejected_before_any_spawn() {
        let err = fetch_issue_detail_with(Path::new("/tmp"), "gh", 0, Duration::from_secs(1))
            .unwrap_err();
        assert!(err.contains("valid issue number"));
    }
}
