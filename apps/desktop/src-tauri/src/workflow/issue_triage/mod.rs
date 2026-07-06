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

mod detail;
mod diff;
mod list;
mod post;
mod shared;

pub(crate) use detail::*;
pub(crate) use diff::*;
pub(crate) use list::*;
pub(crate) use post::*;
// The shared plumbing (`GH_TIMEOUT`, the `ISSUE_*` caps, `cap_text`, the GraphQL
// envelope types, `errors_first`, `parse_pr_state`) is internal to this module tree.
// A private glob re-export binds those `pub(super)` items into `issue_triage` so the
// `detail`/`diff`/`list`/`post` sibling submodules keep reaching them via
// `super::cap_text` / `super::GraphQlResponse` / `super::GH_TIMEOUT` etc. (a
// `pub(super)` re-export would over-promise: the items are only `pub(in
// issue_triage)`, and nothing outside this module references them).
use shared::*;
