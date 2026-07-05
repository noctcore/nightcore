//! Issue Triage — the network-facing `gh` seams (Rust owns every GitHub read/write
//! so the read-only validation session stays offline).
//!
//! Four operations sit on the Rust side:
//! - [`list::list_open_issues`] — `gh api graphql` listing a repo's open issues +
//!   their linked-PR badges (errors[]-first, tolerant parse).
//! - [`detail::fetch_issue_detail`] — `gh api graphql` for one issue's body + its
//!   first page of comments (NO pagination — a non-goal), each capped.
//! - [`diff::fetch_linked_pr_diff`] — `gh pr diff <n>` capped at [`ISSUE_PR_DIFF_MAX_LEN`],
//!   injected as UNTRUSTED context on the start command (best-effort).
//! - [`post::post_issue_comment`] — a SINGLE atomic
//!   `gh api repos/{owner}/{repo}/issues/{n}/comments --method POST --input -` with the
//!   body on STDIN (never argv), built by [`post::build_issue_comment_body`] from the
//!   STRUCTURED verdict (never raw model prose).
//!
//! Safety posture (the PR-arc rules): every `gh` child is bounded by a deadline via
//! [`crate::workflow::pr::run_gh_bounded`]; `gh` stores no tokens; `issue_number` /
//! `pr_number` are `u64` (decimal, injection-safe — never an option token);
//! `{owner}`/`{repo}` are `gh` placeholders resolved from the run cwd, never a raw
//! remote URL across IPC. Every GitHub-sourced text field returned here is UNTRUSTED.

use std::time::Duration;

mod detail;
mod diff;
mod list;
mod post;

pub(crate) use detail::*;
pub(crate) use diff::*;
pub(crate) use list::*;
pub(crate) use post::*;

/// Wall-clock bound on every network-facing Issue-Triage `gh` spawn (list / detail /
/// diff / post). Generous but finite — a black-holed GitHub must error out, not pin
/// the blocking thread.
pub(super) const GH_TIMEOUT: Duration = Duration::from_secs(90);

// === Defense-in-depth size caps, mirroring `packages/contracts/src/issue-triage.ts`
//     (`ISSUE_*` bounds). The zod contract enforces these at the trust boundary; the
//     Rust seam ALSO caps here so a pathological payload is trimmed before it ever
//     reaches the sidecar (context-window / token / memory pressure). Kept in sync by
//     name with the contract constants. ===

/// Max issues returned by the list (first page only — no pagination, a non-goal).
pub(super) const ISSUES_LIST_MAX: usize = 50;
pub(super) const ISSUE_TITLE_MAX_LEN: usize = 1_024;
pub(super) const ISSUE_BODY_MAX_LEN: usize = 65_536;
pub(super) const ISSUE_COMMENT_BODY_MAX_LEN: usize = 65_536;
pub(super) const ISSUE_PR_DIFF_MAX_LEN: usize = 1_048_576;
pub(super) const ISSUE_LABELS_MAX: usize = 100;
pub(super) const ISSUE_COMMENTS_MAX: usize = 100;
pub(super) const ISSUE_LINKED_PRS_MAX: usize = 50;

/// Truncate `text` to at most `cap` bytes at a UTF-8 char boundary, appending a marker
/// when it overflows. Pure, unit-tested. Shared by the body/comment/diff caps.
pub(super) fn cap_text(mut text: String, cap: usize) -> String {
    if text.len() <= cap {
        return text;
    }
    let mut end = cap;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str(&format!("\n[truncated at {cap} bytes]"));
    text
}

// === Shared `gh api graphql` deserialization plumbing (the fetch.rs pattern,
//     generalized): GitHub returns HTTP 200 even on a query failure (a top-level
//     `errors` array with a null `data`), so `data` is optional and every nested node
//     degrades rather than failing the whole snapshot. ===

/// The GraphQL envelope: `data` on success, a non-empty `errors` on failure (with
/// `data` null). Both optional so a partial/odd payload still parses. Generic over the
/// query's `data` shape.
#[derive(Debug, serde::Deserialize)]
pub(super) struct GraphQlResponse<T> {
    // `Option<_>` fields already deserialize a MISSING key as `None` — no `#[serde(default)]`
    // needed (and adding it on a generic `Option<T>` would spuriously demand `T: Default`).
    pub data: Option<T>,
    pub errors: Option<Vec<GraphQlError>>,
}

#[derive(Debug, serde::Deserialize)]
pub(super) struct GraphQlError {
    #[serde(default)]
    pub message: Option<String>,
}

/// A GraphQL connection's `{ nodes: [...] }` wrapper. A manual `Default` (empty nodes)
/// that does NOT bind `T: Default`, so `#[serde(default)]` can pad an absent connection
/// without every node type being `Default`.
#[derive(Debug, serde::Deserialize)]
pub(super) struct GqlNodes<T> {
    #[serde(default = "Vec::new")]
    pub nodes: Vec<T>,
}

impl<T> Default for GqlNodes<T> {
    fn default() -> Self {
        Self { nodes: Vec::new() }
    }
}

/// A ghost/deleted GitHub author (a null `author.login`) reads as this rather than
/// crashing the parse. Display-only — an attacker chooses their own login, so it never
/// feeds a trust decision.
pub(super) const UNKNOWN_AUTHOR: &str = "unknown";

#[derive(Debug, serde::Deserialize)]
pub(super) struct GqlAuthor {
    #[serde(default)]
    pub login: Option<String>,
}

impl GqlAuthor {
    /// The login, or [`UNKNOWN_AUTHOR`] for a ghost author. `self` is the `Option` the
    /// nested node carries, so a whole-null `author` degrades too.
    pub(super) fn login_or_unknown(this: Option<GqlAuthor>) -> String {
        this.and_then(|a| a.login)
            .unwrap_or_else(|| UNKNOWN_AUTHOR.to_string())
    }
}

/// Return `Err` with GitHub's joined error messages when `errors` is present and
/// non-empty — the errors[]-FIRST check every parse runs before reading `data` (a
/// failed query rides an HTTP 200 with a null `data`, so this must precede the
/// not-found fallback). `context` names the query for the empty-message fallback.
pub(super) fn errors_first(
    errors: &Option<Vec<GraphQlError>>,
    context: &str,
) -> Result<(), String> {
    if let Some(errors) = errors.as_ref() {
        if !errors.is_empty() {
            let joined = errors
                .iter()
                .filter_map(|e| e.message.as_deref())
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(if joined.is_empty() {
                format!("GitHub returned an error for the {context}")
            } else {
                joined
            });
        }
    }
    Ok(())
}

/// Map GitHub's UPPERCASE GraphQL PR state (`OPEN`/`CLOSED`/`MERGED`) to the wire
/// lowercase [`crate::contracts::IssuePrState`]. An unrecognized value yields `None`
/// (the caller drops that linked PR rather than guessing a state).
pub(super) fn parse_pr_state(raw: &str) -> Option<crate::contracts::IssuePrState> {
    use crate::contracts::IssuePrState;
    match raw.to_ascii_lowercase().as_str() {
        "open" => Some(IssuePrState::Open),
        "closed" => Some(IssuePrState::Closed),
        "merged" => Some(IssuePrState::Merged),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_text_passes_short_text_through() {
        assert_eq!(cap_text("hi".into(), 100), "hi");
    }

    #[test]
    fn cap_text_truncates_and_marks_overflow_on_a_char_boundary() {
        let out = cap_text("abcdef".repeat(100), 10);
        assert!(out.starts_with("abcdefabcd"));
        assert!(out.contains("[truncated at 10 bytes]"));
        // Never splits a multi-byte char (each `é` is 2 bytes; cap lands mid-char).
        let multi = cap_text("é".repeat(20), 5);
        assert!(multi.starts_with("éé"), "truncates at a char boundary");
    }

    #[test]
    fn errors_first_returns_github_messages_before_data() {
        let errs = Some(vec![
            GraphQlError {
                message: Some("Could not resolve to a Repository".into()),
            },
            GraphQlError { message: None },
        ]);
        let err = errors_first(&errs, "issues query").unwrap_err();
        assert!(err.contains("Could not resolve to a Repository"));
    }

    #[test]
    fn errors_first_is_ok_when_absent_or_empty() {
        assert!(errors_first(&None, "x").is_ok());
        assert!(errors_first(&Some(vec![]), "x").is_ok());
    }

    #[test]
    fn errors_first_falls_back_when_messages_are_blank() {
        let errs = Some(vec![GraphQlError {
            message: Some("  ".into()),
        }]);
        let err = errors_first(&errs, "issues query").unwrap_err();
        assert_eq!(err, "GitHub returned an error for the issues query");
    }

    #[test]
    fn parse_pr_state_maps_uppercase_and_drops_unknown() {
        use crate::contracts::IssuePrState;
        assert_eq!(parse_pr_state("OPEN"), Some(IssuePrState::Open));
        assert_eq!(parse_pr_state("Merged"), Some(IssuePrState::Merged));
        assert_eq!(parse_pr_state("DRAFT"), None);
    }
}
