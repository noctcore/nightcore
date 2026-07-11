//! The terminal sync-comment builder (§3.4): compose ONE GitHub issue comment from
//! STRUCTURED task fields (title / summary / error / pr_url) — never transcript or raw
//! model prose. Pure + deterministic (a given key + task ⇒ identical bytes), mirroring the
//! preview-vs-post guarantee of `build_issue_comment_body` (`workflow/issue_triage/post.rs`).
//! The comment is Nightcore projecting ITS OWN status onto the issue, so it introduces no
//! new prompt surface (nothing here is fed back into a session — §6).

use crate::task::Task;

/// The automated-post provenance footer, appended to every sync comment.
const FOOTER: &str = "\n\n---\n_Posted by Nightcore — automated status update._";

/// Build the issue comment for a sync `key` (`"converted" | "done" | "failed"`) from the
/// task's structured fields. Deterministic and preview-safe. An unrecognized key yields a
/// minimal generic line (never panics).
pub(super) fn build_sync_comment(key: &str, task: &Task) -> String {
    let title = task.title.trim();
    let body = match key {
        "converted" => format!("Nightcore is tracking this issue as task «{title}»."),
        "done" => {
            let mut s = String::from("Completed by Nightcore.");
            if let Some(summary) = trimmed(task.summary.as_deref()) {
                s.push_str(&format!(" Summary: {summary}"));
            }
            if let Some(pr) = trimmed(task.pr_url.as_deref()) {
                s.push_str(&format!("\n\nPR: {pr}"));
            }
            s
        }
        "failed" => {
            let mut s = String::from("The Nightcore run failed.");
            if let Some(err) = trimmed(task.error.as_deref()) {
                s.push_str(&format!(" Error: {err}"));
            }
            s
        }
        _ => format!("Nightcore status update for task «{title}»."),
    };
    format!("{body}{FOOTER}")
}

/// A trimmed, non-empty view of an optional string field (`None` when absent or blank).
fn trimmed(field: Option<&str>) -> Option<&str> {
    field.map(str::trim).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> Task {
        Task::new("Fix the parser panic".into(), "d".into())
    }

    #[test]
    fn converted_names_the_task_and_footers_the_provenance() {
        let body = build_sync_comment("converted", &task());
        assert!(body.contains("Nightcore is tracking this issue as task «Fix the parser panic»."));
        assert!(body.contains("Posted by Nightcore — automated status update."));
    }

    #[test]
    fn done_includes_structured_summary_and_pr_but_never_prose() {
        let mut t = task();
        t.summary = Some("Guarded the empty case and added a regression test.".into());
        t.pr_url = Some("https://github.com/acme/widget/pull/42".into());
        let body = build_sync_comment("done", &t);
        assert!(body.contains("Completed by Nightcore."));
        assert!(body.contains("Guarded the empty case"));
        assert!(body.contains("PR: https://github.com/acme/widget/pull/42"));
    }

    #[test]
    fn done_omits_absent_summary_and_pr() {
        let body = build_sync_comment("done", &task());
        assert!(body.contains("Completed by Nightcore."));
        assert!(!body.contains("Summary:"));
        assert!(!body.contains("PR:"));
    }

    #[test]
    fn failed_surfaces_the_structured_error() {
        let mut t = task();
        t.error = Some("the verification gauntlet failed after 3 fix attempts".into());
        let body = build_sync_comment("failed", &t);
        assert!(body.contains("The Nightcore run failed."));
        assert!(body.contains("Error: the verification gauntlet failed after 3 fix attempts"));
    }

    #[test]
    fn build_is_deterministic_preview_equals_post() {
        let mut t = task();
        t.summary = Some("s".into());
        assert_eq!(
            build_sync_comment("done", &t),
            build_sync_comment("done", &t)
        );
    }
}
