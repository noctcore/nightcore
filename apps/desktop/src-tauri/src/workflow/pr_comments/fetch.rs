//! The `gh api graphql` seam + its tolerant deserialization: run the bounded
//! read-only query and classify its payload into the wire contract. GitHub
//! returns HTTP 200 even on a query failure (a top-level `errors` array with a
//! null `data`), so every nested node is optional with a safe default — field /
//! vocabulary drift degrades a field, never the whole snapshot.

use std::path::Path;
use std::time::Duration;

use super::{PrComment, PrReviewComments, PrReviewSummary, PrThread};
use crate::git::gh::{run_gh_checked, GhCall};

/// Wall-clock bound on the read-only `gh api graphql` fetch — comments move no
/// data, so a black-holed GitHub should fail the refresh fast, not pin a blocking
/// thread. Matches the tighter `pr_status` view bound.
pub(super) const GH_COMMENTS_TIMEOUT: Duration = Duration::from_secs(60);

/// The GraphQL query for the review comments: the UNRESOLVED-filterable inline
/// threads (with their anchor + comments) and the top-level reviews (author +
/// state + body). Single line — gh sends it verbatim. `$owner`/`$name` resolve
/// from the repo in the run cwd (the `{owner}`/`{repo}` placeholders below);
/// `$number` is typed Int via `-F`.
const GRAPHQL_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:50){nodes{author{login} body}}}} reviews(first:50){nodes{author{login} state body}}}}}";

/// The GraphQL envelope: `data` on success, a non-empty `errors` on failure
/// (with `data` null). Both optional so a partial/odd payload still parses.
#[derive(Debug, serde::Deserialize)]
struct GraphQlResponse {
    #[serde(default)]
    data: Option<GraphQlData>,
    #[serde(default)]
    errors: Option<Vec<GraphQlError>>,
}

#[derive(Debug, serde::Deserialize)]
struct GraphQlError {
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GraphQlData {
    #[serde(default)]
    repository: Option<GqlRepository>,
}

#[derive(Debug, serde::Deserialize)]
struct GqlRepository {
    #[serde(default, rename = "pullRequest")]
    pull_request: Option<GqlPullRequest>,
}

#[derive(Debug, serde::Deserialize)]
struct GqlPullRequest {
    #[serde(default, rename = "reviewThreads")]
    review_threads: GqlNodes<GqlThread>,
    #[serde(default)]
    reviews: GqlNodes<GqlReview>,
}

/// A GraphQL connection's `{ nodes: [...] }` wrapper. A manual `Default` (empty
/// nodes) that does NOT bind `T: Default`, so `#[serde(default)]` can pad an
/// absent connection without every node type being `Default`.
#[derive(Debug, serde::Deserialize)]
struct GqlNodes<T> {
    #[serde(default = "Vec::new")]
    nodes: Vec<T>,
}

impl<T> Default for GqlNodes<T> {
    fn default() -> Self {
        Self { nodes: Vec::new() }
    }
}

#[derive(Debug, serde::Deserialize)]
struct GqlThread {
    #[serde(default, rename = "isResolved")]
    is_resolved: bool,
    #[serde(default, rename = "isOutdated")]
    is_outdated: bool,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    comments: GqlNodes<GqlComment>,
}

#[derive(Debug, serde::Deserialize)]
struct GqlComment {
    #[serde(default)]
    author: Option<GqlAuthor>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GqlReview {
    #[serde(default)]
    author: Option<GqlAuthor>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GqlAuthor {
    #[serde(default)]
    login: Option<String>,
}

/// A ghost/deleted GitHub author (a null `author.login`) reads as this rather
/// than crashing the parse.
const UNKNOWN_AUTHOR: &str = "unknown";

/// Parse a `gh api graphql` review-comments payload into the wire contract
/// (PURE — the whole classification is unit-tested off a fixed payload):
/// - a non-empty top-level `errors` array → Err (GitHub failed the query);
/// - a null/absent `data.repository.pullRequest` → Err "not found";
/// - threads kept only when `isResolved == false` and they carry >=1 comment;
/// - reviews kept only when their `body` is non-blank.
pub(super) fn parse_review_comments(stdout: &str) -> Result<PrReviewComments, String> {
    let response: GraphQlResponse = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("`gh api graphql` returned unparseable JSON: {e}"))?;

    // GraphQL errors ride an HTTP 200 with a null `data` — check them FIRST so a
    // failed query surfaces GitHub's message, not the "not found" fallback.
    if let Some(errors) = response.errors.as_ref() {
        if !errors.is_empty() {
            let joined = errors
                .iter()
                .filter_map(|e| e.message.as_deref())
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(if joined.is_empty() {
                "GitHub returned an error for the review-comments query".to_string()
            } else {
                joined
            });
        }
    }

    // A null repository/pullRequest (e.g. the PR was deleted, or the number is
    // wrong) is a clear not-found, never an empty success.
    let pr = response
        .data
        .and_then(|d| d.repository)
        .and_then(|r| r.pull_request)
        .ok_or_else(|| "the pull request was not found on GitHub".to_string())?;

    let threads = pr
        .review_threads
        .nodes
        .into_iter()
        .filter(|t| !t.is_resolved)
        .filter_map(|t| {
            let comments: Vec<PrComment> = t
                .comments
                .nodes
                .into_iter()
                .map(|c| PrComment {
                    author: c
                        .author
                        .and_then(|a| a.login)
                        .unwrap_or_else(|| UNKNOWN_AUTHOR.to_string()),
                    body: c.body.unwrap_or_default(),
                })
                .collect();
            // A thread with zero comments has nothing to show or fix.
            if comments.is_empty() {
                return None;
            }
            Some(PrThread {
                path: t.path,
                line: t.line,
                is_outdated: t.is_outdated,
                comments,
            })
        })
        .collect();

    let reviews = pr
        .reviews
        .nodes
        .into_iter()
        .filter_map(|r| {
            let body = r.body.unwrap_or_default();
            // Only reviews with a written summary are actionable; an APPROVE with
            // an empty body carries no instruction.
            if body.trim().is_empty() {
                return None;
            }
            Some(PrReviewSummary {
                author: r
                    .author
                    .and_then(|a| a.login)
                    .unwrap_or_else(|| UNKNOWN_AUTHOR.to_string()),
                state: r.state.unwrap_or_default(),
                body,
            })
        })
        .collect();

    Ok(PrReviewComments { threads, reviews })
}

/// Run `gh api graphql …` in `dir` (bounded by `deadline`) and parse it into the
/// wire contract. Binary-parameterized — the injection seam the tests use to
/// exercise the real spawn path with a fake script (the phase-1 template).
pub(super) fn fetch_review_comments_with(
    dir: &Path,
    binary: &str,
    number: u64,
    deadline: Duration,
) -> Result<PrReviewComments, String> {
    // gh resolves `{owner}`/`{repo}` from the repo in `dir`; `-F number=<n>`
    // types it as Int for the `Int!` variable; the query rides in a `query=…`
    // string field.
    let number_arg = format!("number={number}");
    let query_arg = format!("query={GRAPHQL_QUERY}");
    let stdout = run_gh_checked(GhCall {
        dir,
        binary,
        args: &[
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
        action: "install it to track pull requests",
        subcmd: "api graphql",
        stdin: None,
        deadline,
        timeout_msg: "timed out reading review comments from GitHub — check your network and try again",
    })?;
    parse_review_comments(&stdout)
}
