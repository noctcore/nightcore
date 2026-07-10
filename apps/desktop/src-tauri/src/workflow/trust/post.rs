//! The Trust Report PR ATTACHMENT seam (wayfinder #91, PR 3): post the canonical
//! GitHub-rendered receipt (`render_for_github`) as a conversation comment on the
//! task's pull request.
//!
//! It clones the house comment-post idiom `post_push_comment_with`
//! (`workflow::pr_fix::comment`): the payload is built with `serde_json` (NEVER a
//! string-formatted JSON body) and posted via `gh api … --input -` with the body
//! on STDIN, bound by its own deadline. Trust posture: the standalone attach is a
//! SEPARATE action from create/merge — it takes NO `pr_in_flight` create/merge
//! lease (§3.9), runs under its own timeout, and is human-gated + single-flight on
//! the web side (the Trust band's ConfirmDialog + its pending guard). The rendered
//! body is the GitHub-safe fenced receipt (`render_for_github`), so the untrusted
//! ledger digests it embeds are already neutralized (§3.6).

use std::path::Path;
use std::time::Duration;

use serde_json::json;

use crate::git::gh::{run_gh_checked, GhCall};
use crate::task::Task;

/// Wall-clock bound on the comment POST (one small write) — mirrors the pr-fix
/// summary comment's `GH_COMMENT_TIMEOUT`.
pub(crate) const GH_COMMENT_TIMEOUT: Duration = Duration::from_secs(60);

/// The PR number to attach the receipt to, or a clear error when the task has no
/// pull request — the attach must FAIL loudly, never silently no-op (§3.9). The
/// number is written together with `pr_url` at create time (`store/task/model.rs`),
/// so its presence is the durable "this task has a PR" signal.
pub(crate) fn require_pr_number(task: &Task) -> Result<u64, String> {
    task.pr_number.ok_or_else(|| {
        format!(
            "task {} has no pull request — create a PR before attaching the Trust Report",
            task.id
        )
    })
}

/// POST one issue comment carrying the receipt on the PR via `gh api … --input -`
/// (the issues endpoint writes PR conversation comments). Binary-parameterized —
/// the production caller passes [`crate::git::gh::GH_BINARY`]; tests inject a fake
/// `gh` script. `{owner}/{repo}` are resolved by `gh` from the cwd repo (`dir`),
/// so the raw remote URL never crosses IPC.
pub(crate) fn post_trust_comment_with(
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
        action: "install it to attach the Trust Report",
        subcmd: "api",
        stdin: Some(&payload),
        deadline,
        timeout_msg: "timed out posting the Trust Report comment to GitHub",
    })?;
    Ok(())
}
