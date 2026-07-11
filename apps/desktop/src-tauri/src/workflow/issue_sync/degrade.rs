//! The writeback orchestrator + the permission-degradation ladder (§3.6 step 6, §3.8).
//!
//! [`apply_writeback_with`] runs the label delta (§3.3) then the terminal comment (§3.4)
//! under the ladder: a token that lacks `issues:write` returns HTTP 403 / "Resource not
//! accessible", which DEGRADES the project (never a retry-storm) rather than erroring —
//! Full → comments-only → silent-off, each downgrade cached per project so we probe once,
//! not on every transition. A non-403 failure is TRANSIENT: no downgrade, the field is
//! left unstamped so the next `nc:task` naturally retries. Binary-parameterized so the
//! tests drive the whole ladder through a fake `gh` — no live GitHub traffic.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use super::comment::build_sync_comment;
use super::labels::{
    add_label_with, ensure_label_with, remove_label_with, spec_for, GH_LABEL_TIMEOUT,
};
use super::transition::{pending_work, Pending};
use crate::git::gh::GH_BINARY;
use crate::task::Task;
use crate::workflow::issue_triage::post_issue_comment_with;

/// The comments-only degradation notice (§3.8 tier 2) — a human message, never a token.
const COMMENTS_ONLY_MSG: &str =
    "sync running comments-only: the token can't manage labels on this repo";
/// The silent-off degradation notice (§3.8 tier 3).
const PAUSED_MSG: &str = "issue sync paused: the token lacks write access to this repo";

/// The writeback capability tier for a project, downgraded (never upgraded automatically)
/// as 403s reveal missing scope. Ordered by shrinking capability.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum SyncTier {
    /// Labels + comments (+ the PR `Closes #N`, which needs no issue scope). Happy path.
    Full,
    /// Labels 403'd — skip them, keep posting terminal comments.
    CommentsOnly,
    /// Comments also 403'd — writeback disabled for this repo until re-enabled.
    SilentOff,
}

/// The field mutations a writeback produces, for the command to stamp on the task
/// best-effort (a store hiccup must not turn a landed GitHub write into a failure).
pub(crate) struct WritebackOutcome {
    /// The `nc:*` label now on the issue (`None` = removed / none), or the prior value
    /// unchanged when a label write failed transiently.
    pub(crate) synced_label: Option<String>,
    /// Epoch-ms of the last SUCCESSFUL label write (bumped only when `synced_label` moved).
    pub(crate) synced_at: Option<u64>,
    /// The last terminal comment key posted, or the prior value when no comment landed.
    pub(crate) comment_marker: Option<String>,
    /// The degradation notice to surface (`None` when healthy or transiently-failed).
    pub(crate) sync_error: Option<String>,
    /// Whether any stamped field moved — the command persists + emits only on `true`.
    pub(crate) changed: bool,
}

/// Per-project downgrade cache: once a project reveals missing scope we probe once, not on
/// every transition. Keyed by project path; absent ⇒ [`SyncTier::Full`].
fn downgrade_cache() -> &'static Mutex<HashMap<String, SyncTier>> {
    static CACHE: OnceLock<Mutex<HashMap<String, SyncTier>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn current_tier(dir: &Path) -> SyncTier {
    crate::sync::lock_or_recover(downgrade_cache())
        .get(dir.to_string_lossy().as_ref())
        .copied()
        .unwrap_or(SyncTier::Full)
}

fn downgrade(dir: &Path, tier: SyncTier) {
    crate::sync::lock_or_recover(downgrade_cache())
        .insert(dir.to_string_lossy().into_owned(), tier);
    tracing::warn!(target: "nightcore", project = %dir.display(), tier = ?tier, "issue-sync degraded for this repo");
}

/// Classify a `gh` mutation failure: a 403 / "Resource not accessible" / insufficient-scope
/// signature is a permission DOWNGRADE (skip this write path for the repo); anything else
/// is transient (no downgrade — the next transition retries). Matches the §3.8 ladder over
/// the `map_gh_failure` / `map_post_failure` surfaces.
fn is_scope_denied(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("http 403") || e.contains("resource not accessible") || e.contains("must have")
}

/// Production entry point — [`apply_writeback_with`] against the real `gh`.
pub(crate) fn apply_writeback(
    dir: &Path,
    prefix: &str,
    issue_number: u64,
    task: &Task,
) -> WritebackOutcome {
    apply_writeback_with(dir, GH_BINARY, prefix, issue_number, task, GH_LABEL_TIMEOUT)
}

/// Apply the label delta then the terminal comment under the degradation ladder, returning
/// the fields to stamp. Assumes the caller already checked [`Pending::is_noop`] (so there
/// IS work) and holds the per-root mutation lease. Binary-parameterized for the fake-`gh`
/// tests.
pub(crate) fn apply_writeback_with(
    dir: &Path,
    binary: &str,
    prefix: &str,
    issue_number: u64,
    task: &Task,
    deadline: Duration,
) -> WritebackOutcome {
    // Seed from the task's current sync state; each successful write advances a field, a
    // failure leaves it so the next transition retries.
    let mut synced_label = task.issue_synced_label.clone();
    let mut synced_at = task.issue_synced_at;
    let mut comment_marker = task.issue_comment_marker.clone();
    let mut sync_error: Option<String> = None;

    let mut tier = current_tier(dir);
    if tier == SyncTier::SilentOff {
        // Cached off — surface the paused notice, issue zero `gh` calls.
        return finish(
            task,
            synced_label,
            synced_at,
            comment_marker,
            Some(PAUSED_MSG.to_string()),
        );
    }

    let pending = pending_work(task, prefix);

    // ── Labels (Full tier only) ──
    if tier == SyncTier::Full && pending.label_changed() {
        match apply_label_delta(dir, binary, issue_number, &pending, deadline) {
            Ok(()) => {
                synced_label = pending.desired_full.clone();
                synced_at = Some(crate::task::now_ms());
                tracing::info!(target: "nightcore", issue = issue_number, label = ?synced_label, "issue-sync label projected");
            }
            Err(e) if is_scope_denied(&e) => {
                tier = SyncTier::CommentsOnly;
                downgrade(dir, tier);
                sync_error = Some(COMMENTS_ONLY_MSG.to_string());
            }
            Err(e) => {
                // Transient — no downgrade; leave `synced_label` for the next retry.
                tracing::warn!(target: "nightcore", issue = issue_number, error = %e, "issue-sync label write failed (transient); will retry");
            }
        }
    }

    // ── Comment (Full or CommentsOnly) ──
    if tier != SyncTier::SilentOff {
        if let Some(key) = pending.comment_due {
            let body = build_sync_comment(key, task);
            match post_issue_comment_with(dir, binary, issue_number, &body, deadline) {
                Ok(_url) => {
                    comment_marker = Some(key.to_string());
                    tracing::info!(target: "nightcore", issue = issue_number, comment = key, "issue-sync comment posted");
                    // A comment that landed while comments-only keeps the tier-2 notice.
                    if tier == SyncTier::CommentsOnly {
                        sync_error = Some(COMMENTS_ONLY_MSG.to_string());
                    }
                }
                Err(e) if is_scope_denied(&e) => {
                    downgrade(dir, SyncTier::SilentOff);
                    sync_error = Some(PAUSED_MSG.to_string());
                }
                Err(e) => {
                    tracing::warn!(target: "nightcore", issue = issue_number, error = %e, "issue-sync comment post failed (transient); will retry");
                    if sync_error.is_none() && tier == SyncTier::CommentsOnly {
                        sync_error = Some(COMMENTS_ONLY_MSG.to_string());
                    }
                }
            }
        } else if tier == SyncTier::CommentsOnly {
            // No comment due but we degraded this run — still surface the notice.
            sync_error = Some(COMMENTS_ONLY_MSG.to_string());
        }
    }

    finish(task, synced_label, synced_at, comment_marker, sync_error)
}

/// A label SWITCH: `ensure(desired)` → `add(desired)` → `remove(prev)`. The add lands
/// BEFORE the remove so the issue is never momentarily unlabeled; a merged task (no
/// desired) is just the remove. `prev` comes from the task (no read/list call).
fn apply_label_delta(
    dir: &Path,
    binary: &str,
    issue_number: u64,
    pending: &Pending,
    deadline: Duration,
) -> Result<(), String> {
    if let Some(desired) = pending.desired_full.as_deref() {
        if let Some(spec) = pending.desired_suffix.and_then(spec_for) {
            ensure_label_with(dir, binary, desired, spec.color, spec.description, deadline)?;
        }
        add_label_with(dir, binary, issue_number, desired, deadline)?;
    }
    if let Some(prev) = pending.prev_full.as_deref() {
        if Some(prev) != pending.desired_full.as_deref() {
            remove_label_with(dir, binary, issue_number, prev, deadline)?;
        }
    }
    Ok(())
}

/// Assemble the outcome, computing `changed` against the task's pre-writeback fields.
fn finish(
    task: &Task,
    synced_label: Option<String>,
    synced_at: Option<u64>,
    comment_marker: Option<String>,
    sync_error: Option<String>,
) -> WritebackOutcome {
    let changed = synced_label != task.issue_synced_label
        || comment_marker != task.issue_comment_marker
        || sync_error != task.issue_sync_error;
    WritebackOutcome {
        synced_label,
        synced_at,
        comment_marker,
        sync_error,
        changed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::TaskStatus;

    #[cfg(unix)]
    fn fake_gh(dir: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-gh.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
        let mut perms = std::fs::metadata(&path).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod");
        path
    }

    fn backlog_task() -> Task {
        // A freshly-converted task: queued label due + the converted comment due.
        let mut t = Task::new("Fix the parser".into(), "d".into());
        t.status = TaskStatus::Backlog;
        t
    }

    #[test]
    #[cfg(unix)]
    fn full_success_stamps_label_and_comment_in_order() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        // Log each invocation's argv (append) and succeed. `gh api …/comments` returns a
        // JSON object; the label calls return empty.
        let gh = fake_gh(
            tmp.path(),
            "printf 'CALL %s\\n' \"$*\" >> calls.txt\n\
             case \"$*\" in *comments*) echo '{\"html_url\":\"u\"}';; esac\nexit 0",
        );
        let out = apply_writeback_with(
            tmp.path(),
            gh.to_str().unwrap(),
            "nc:",
            7,
            &backlog_task(),
            Duration::from_secs(5),
        );
        assert_eq!(out.synced_label.as_deref(), Some("nc:queued"));
        assert_eq!(out.comment_marker.as_deref(), Some("converted"));
        assert_eq!(out.sync_error, None);
        assert!(out.changed);
        assert!(out.synced_at.is_some());
        let calls = std::fs::read_to_string(tmp.path().join("calls.txt")).expect("calls");
        // ensure (labels create) + add (issues/labels) + comment, in that order; no prev to
        // remove (prev_full is None for a first sync).
        let order: Vec<&str> = calls.lines().collect();
        assert!(
            order[0].contains("repos/{owner}/{repo}/labels"),
            "ensure first: {order:?}"
        );
        assert!(
            order[1].contains("issues/7/labels"),
            "add second: {order:?}"
        );
        assert!(order[2].contains("comments"), "comment third: {order:?}");
    }

    #[test]
    #[cfg(unix)]
    fn label_switch_issues_add_then_remove_of_prev() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let gh = fake_gh(
            tmp.path(),
            "printf 'CALL %s\\n' \"$*\" >> calls.txt\nexit 0",
        );
        // in-progress → done, no comment marker moves the label; converted already posted.
        let mut t = Task::new("t".into(), "d".into());
        t.status = TaskStatus::Done;
        t.issue_synced_label = Some("nc:in-progress".into());
        t.issue_comment_marker = Some("done".into()); // suppress the done comment for this test
        let out = apply_writeback_with(
            tmp.path(),
            gh.to_str().unwrap(),
            "nc:",
            9,
            &t,
            Duration::from_secs(5),
        );
        assert_eq!(out.synced_label.as_deref(), Some("nc:done"));
        let calls = std::fs::read_to_string(tmp.path().join("calls.txt")).expect("calls");
        let add_at = calls.lines().position(|l| l.contains("labels[]=nc:done"));
        let del_at = calls
            .lines()
            .position(|l| l.contains("DELETE") && l.contains("issues/9/labels/nc:in-progress"));
        assert!(
            add_at.is_some() && del_at.is_some(),
            "both add + remove issued: {calls}"
        );
        assert!(
            add_at < del_at,
            "add must precede remove (never unlabeled): {calls}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_403_downgrades_comments_only_then_silent_off() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        // Every call 403s.
        let gh = fake_gh(
            tmp.path(),
            "echo 'gh: Resource not accessible by personal access token (HTTP 403)' 1>&2\nexit 1",
        );
        let out = apply_writeback_with(
            tmp.path(),
            gh.to_str().unwrap(),
            "nc:",
            7,
            &backlog_task(),
            Duration::from_secs(5),
        );
        // The label 403 → comments-only; the comment 403 → silent-off (final).
        assert_eq!(current_tier(tmp.path()), SyncTier::SilentOff);
        assert_eq!(out.sync_error.as_deref(), Some(PAUSED_MSG));
        assert_eq!(out.synced_label, None, "no label landed");
        assert_eq!(out.comment_marker, None, "no comment landed");
    }

    #[test]
    #[cfg(unix)]
    fn a_transient_failure_does_not_downgrade() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        // A 500 (transient) on every call.
        let gh = fake_gh(
            tmp.path(),
            "echo 'gh: Server Error (HTTP 500)' 1>&2\nexit 1",
        );
        let out = apply_writeback_with(
            tmp.path(),
            gh.to_str().unwrap(),
            "nc:",
            7,
            &backlog_task(),
            Duration::from_secs(5),
        );
        assert_eq!(
            current_tier(tmp.path()),
            SyncTier::Full,
            "transient never downgrades"
        );
        assert_eq!(
            out.sync_error, None,
            "no degradation notice on a transient error"
        );
        assert_eq!(
            out.synced_label, None,
            "label unchanged so it retries next transition"
        );
    }

    #[test]
    fn silent_off_is_a_pure_noop_that_surfaces_the_paused_notice() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        downgrade(tmp.path(), SyncTier::SilentOff);
        // A binary that would fail loudly if spawned — it must not be.
        let out = apply_writeback_with(
            tmp.path(),
            "/nonexistent/gh-should-not-run",
            "nc:",
            7,
            &backlog_task(),
            Duration::from_secs(5),
        );
        assert_eq!(out.sync_error.as_deref(), Some(PAUSED_MSG));
        assert_eq!(out.synced_label, None);
    }
}
