//! List a repo's OPEN issues + their linked-PR badges via `gh api graphql`.
//!
//! The list view's data source (design §UX flow 1). Returns [`IssueSummary`] — the
//! Rust-seam shape the web casts against the zod `IssueSummarySchema` (NOT part of the
//! engine NDJSON protocol, so not mirrored into `generated.rs`). Linked PRs are a
//! best-effort extraction from the issue's timeline cross-references; drift there
//! degrades the badge, never the whole list.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{
    cap_text, errors_first, parse_pr_state, GqlAuthor, GqlNodes, GraphQlResponse, ISSUES_LIST_MAX,
    ISSUE_LABELS_MAX, ISSUE_LINKED_PRS_MAX, ISSUE_TITLE_MAX_LEN,
};
use crate::contracts::IssueLinkedPrContext;
use crate::git::gh::{map_gh_failure, probe_gh, run_gh_bounded, GH_BINARY};

/// One issue as it appears in the list view — the Rust-seam mirror of the zod
/// `IssueSummarySchema` (serializes to its exact camelCase shape; the web casts it).
/// `state` is kept as its wire string (`open`); `linkedPrs` reuses the contract
/// [`IssueLinkedPrContext`] with `diff` absent (the diff is a separate, capped fetch
/// carried only into the engine). Every text field is GitHub-sourced (untrusted).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u64,
    pub title: String,
    /// Wire `IssueState` string (`open`/`closed`); the list only returns open issues.
    pub state: String,
    pub labels: Vec<String>,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub comment_count: u64,
    pub linked_prs: Vec<IssueLinkedPrContext>,
}

/// Single line — `gh` sends it verbatim. `$owner`/`$name` resolve from the repo in the
/// run cwd (`{owner}`/`{repo}`). Open issues, newest-updated first; each issue's
/// timeline cross-references/connections are scanned for linked PullRequests (best
/// effort — GitHub surfaces a "Fixes #n" PR as a cross-reference).
const GRAPHQL_QUERY: &str = "query($owner:String!,$name:String!,$first:Int!){repository(owner:$owner,name:$name){issues(first:$first,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title state createdAt updatedAt author{login} labels(first:100){nodes{name}} comments{totalCount} timelineItems(first:30,itemTypes:[CONNECTED_EVENT,CROSS_REFERENCED_EVENT]){nodes{__typename ... on ConnectedEvent{subject{__typename ... on PullRequest{number title state}}} ... on CrossReferencedEvent{source{__typename ... on PullRequest{number title state}}}}}}}}}";

#[derive(Debug, Deserialize)]
struct Data {
    #[serde(default)]
    repository: Option<Repository>,
}

#[derive(Debug, Deserialize)]
struct Repository {
    #[serde(default)]
    issues: GqlNodes<GqlIssue>,
}

#[derive(Debug, Deserialize)]
struct GqlIssue {
    #[serde(default)]
    number: Option<u64>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default, rename = "createdAt")]
    created_at: Option<String>,
    #[serde(default, rename = "updatedAt")]
    updated_at: Option<String>,
    #[serde(default)]
    author: Option<GqlAuthor>,
    #[serde(default)]
    labels: GqlNodes<GqlLabel>,
    #[serde(default)]
    comments: GqlCount,
    #[serde(default, rename = "timelineItems")]
    timeline_items: GqlNodes<GqlTimelineNode>,
}

#[derive(Debug, Deserialize)]
struct GqlLabel {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct GqlCount {
    #[serde(default, rename = "totalCount")]
    total_count: u64,
}

/// A timeline node that may reference a PullRequest via `subject` (ConnectedEvent) or
/// `source` (CrossReferencedEvent). Both optional so unrelated timeline items parse.
#[derive(Debug, Deserialize)]
struct GqlTimelineNode {
    #[serde(default)]
    subject: Option<GqlRef>,
    #[serde(default)]
    source: Option<GqlRef>,
}

/// A referenced subject/source — an Issue or a PullRequest. Kept only when
/// `__typename == "PullRequest"`. Issues carry the same number/title/state fields, so
/// the typename filter is what distinguishes them.
#[derive(Debug, Deserialize)]
struct GqlRef {
    #[serde(default, rename = "__typename")]
    typename: Option<String>,
    #[serde(default)]
    number: Option<u64>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

impl GqlRef {
    /// Convert a PullRequest reference into a linked-PR badge, or `None` for a
    /// non-PR / malformed / unknown-state reference.
    fn into_linked_pr(self) -> Option<IssueLinkedPrContext> {
        if self.typename.as_deref() != Some("PullRequest") {
            return None;
        }
        let number = self.number?;
        let state = parse_pr_state(self.state.as_deref()?)?;
        Some(IssueLinkedPrContext {
            number,
            title: cap_text(self.title.unwrap_or_default(), ISSUE_TITLE_MAX_LEN),
            state,
            diff: None,
        })
    }
}

/// Parse a `gh api graphql` issues payload into [`IssueSummary`]s (PURE — unit-tested
/// off a fixed payload): errors[]-FIRST, then a null repository is a not-found, then
/// each issue with a resolvable number is kept (missing number ⇒ dropped). Linked PRs
/// are deduped by number and capped.
pub(super) fn parse_issue_list(stdout: &str) -> Result<Vec<IssueSummary>, String> {
    let response: GraphQlResponse<Data> = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("`gh api graphql` returned unparseable JSON: {e}"))?;
    errors_first(&response.errors, "issues query")?;

    let repository = response
        .data
        .and_then(|d| d.repository)
        .ok_or_else(|| "the repository was not found on GitHub".to_string())?;

    let issues = repository
        .issues
        .nodes
        .into_iter()
        .filter_map(|issue| {
            let number = issue.number?;
            let labels: Vec<String> = issue
                .labels
                .nodes
                .into_iter()
                .filter_map(|l| l.name)
                .take(ISSUE_LABELS_MAX)
                .collect();
            let mut linked_prs: Vec<IssueLinkedPrContext> = Vec::new();
            for node in issue.timeline_items.nodes {
                if let Some(pr) = node
                    .subject
                    .and_then(GqlRef::into_linked_pr)
                    .or_else(|| node.source.and_then(GqlRef::into_linked_pr))
                {
                    if !linked_prs
                        .iter()
                        .any(|existing| existing.number == pr.number)
                    {
                        linked_prs.push(pr);
                    }
                }
            }
            linked_prs.truncate(ISSUE_LINKED_PRS_MAX);
            Some(IssueSummary {
                number,
                title: cap_text(issue.title.unwrap_or_default(), ISSUE_TITLE_MAX_LEN),
                state: issue
                    .state
                    .unwrap_or_else(|| "open".to_string())
                    .to_lowercase(),
                labels,
                author: GqlAuthor::login_or_unknown(issue.author),
                created_at: issue.created_at.unwrap_or_default(),
                updated_at: issue.updated_at.unwrap_or_default(),
                comment_count: issue.comments.total_count,
                linked_prs,
            })
        })
        .collect();
    Ok(issues)
}

/// Production entry point: list the active repo's open issues in `dir`.
pub(crate) fn list_open_issues(dir: &Path) -> Result<Vec<IssueSummary>, String> {
    list_open_issues_with(dir, GH_BINARY, super::GH_TIMEOUT)
}

/// Binary-parameterized list — the injection seam the tests exercise with a fake `gh`.
pub(super) fn list_open_issues_with(
    dir: &Path,
    binary: &str,
    deadline: Duration,
) -> Result<Vec<IssueSummary>, String> {
    probe_gh(binary, "install it to list issues")?;
    let first_arg = format!("first={ISSUES_LIST_MAX}");
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
            &first_arg,
            "-f",
            &query_arg,
        ],
        None,
        deadline,
        "timed out listing issues from GitHub — check your network and try again",
    )?;
    if !out.status.success() {
        return Err(map_gh_failure(binary, "api graphql", &out));
    }
    parse_issue_list(&out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::IssuePrState;

    #[test]
    fn parses_issues_with_labels_and_linked_prs() {
        let payload = serde_json::json!({
            "data": { "repository": { "issues": { "nodes": [
                {
                    "number": 7, "title": "Crash on empty input", "state": "OPEN",
                    "createdAt": "2026-07-01T00:00:00Z", "updatedAt": "2026-07-04T00:00:00Z",
                    "author": { "login": "alice" },
                    "labels": { "nodes": [{ "name": "bug" }, { "name": "p1" }] },
                    "comments": { "totalCount": 3 },
                    "timelineItems": { "nodes": [
                        { "__typename": "CrossReferencedEvent",
                          "source": { "__typename": "PullRequest", "number": 9, "title": "Fix crash", "state": "OPEN" } },
                        { "__typename": "CrossReferencedEvent",
                          "source": { "__typename": "Issue", "number": 5, "title": "dup", "state": "OPEN" } },
                        { "__typename": "ConnectedEvent",
                          "subject": { "__typename": "PullRequest", "number": 9, "title": "Fix crash", "state": "OPEN" } }
                    ] }
                }
            ] } } }
        })
        .to_string();
        let issues = parse_issue_list(&payload).expect("parse");
        assert_eq!(issues.len(), 1);
        let issue = &issues[0];
        assert_eq!(issue.number, 7);
        assert_eq!(issue.state, "open");
        assert_eq!(issue.author, "alice");
        assert_eq!(issue.labels, vec!["bug".to_string(), "p1".to_string()]);
        assert_eq!(issue.comment_count, 3);
        // The cross-referenced Issue is filtered out; the PR is deduped across the two
        // timeline items that mention it.
        assert_eq!(issue.linked_prs.len(), 1);
        assert_eq!(issue.linked_prs[0].number, 9);
        assert_eq!(issue.linked_prs[0].state, IssuePrState::Open);
        assert!(
            issue.linked_prs[0].diff.is_none(),
            "no diff on a list badge"
        );
    }

    #[test]
    fn errors_array_takes_precedence_over_data() {
        let payload = serde_json::json!({
            "data": null,
            "errors": [{ "message": "Could not resolve to a Repository with the name 'o/r'." }]
        })
        .to_string();
        let err = parse_issue_list(&payload).unwrap_err();
        assert!(err.contains("Could not resolve to a Repository"));
    }

    #[test]
    fn null_repository_is_a_not_found() {
        let payload = serde_json::json!({ "data": { "repository": null } }).to_string();
        let err = parse_issue_list(&payload).unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn ghost_author_and_missing_fields_degrade_not_crash() {
        let payload = serde_json::json!({
            "data": { "repository": { "issues": { "nodes": [
                { "number": 1, "title": null, "author": null,
                  "labels": { "nodes": [] }, "comments": {}, "timelineItems": { "nodes": [] } }
            ] } } }
        })
        .to_string();
        let issues = parse_issue_list(&payload).expect("parse");
        assert_eq!(issues[0].author, "unknown");
        assert_eq!(issues[0].title, "");
        assert_eq!(issues[0].comment_count, 0);
        assert_eq!(issues[0].state, "open", "missing state defaults to open");
    }

    #[test]
    fn an_issue_without_a_number_is_dropped() {
        let payload = serde_json::json!({
            "data": { "repository": { "issues": { "nodes": [ { "title": "no number" } ] } } }
        })
        .to_string();
        assert!(parse_issue_list(&payload).expect("parse").is_empty());
    }
}
