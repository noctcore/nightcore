//! PR status tracking + the remote-merge closeout (PR arc, phase 2 — design §4).
//!
//! Four commands over the phase-1 seams ([`super::pr`]):
//! - [`pr_status`] — read-only `gh pr view` snapshot ([`PrStatus`]) fetched on
//!   demand (mount + manual refresh, NO background polling), plus a LOCAL
//!   unpushed-commits count. No lease — it mutates nothing.
//! - [`push_pr_updates`] — re-push the task branch (plain push, never
//!   `--force`) so review-round fixes reach the open PR. Human-gated in the UI.
//! - [`finalize_merged_pr`] — close the loop on a PR merged ON GitHub: verify
//!   `state == MERGED` server-side (never trust the caller), then mirror the
//!   local merge's post-merge tail (cleanup + `merged` flag + `nc:task`).
//! - [`pull_base_ff`] — fast-forward-ONLY update of the base branch on the
//!   project root (`git fetch` + `git merge --ff-only`; a non-ff base surfaces
//!   git's error verbatim, never a real merge).
//!
//! Safety posture (the phase-1 rules, unchanged): every ref through
//! `validate_ref` + `--end-of-options` at the call sites; every `git`/`gh`
//! child bounded by `wait_with_deadline`; no raw remote URLs across IPC
//! ([`PrStatus::url`] is the gh-reported PR page URL); the mutating commands
//! take the same per-task leases + cross-action refusals as merge/commit/PR
//! creation, so a finalize can never delete a worktree out from under an
//! in-flight push.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
// ts-rs is a dev-dependency (the Rust→TS codegen runs under `cargo test` only).
#[cfg(test)]
use ts_rs::TS;

use super::merge::{commit_in_flight, lease_held, merge_in_flight, require_project, TaskLease};
use super::pr::{pr_in_flight, run_gh_bounded, GH_BINARY};
use crate::settings::SettingsStore;
use crate::store::TaskStore;
use crate::task::{Task, TASK_EVENT};
use crate::worktree::{self, validate_ref};

/// Wall-clock bound on the read-only `gh pr view` spawns (status + the finalize
/// re-verification). Tighter than the create/push bound — a view moves no data,
/// so a black-holed GitHub should fail the refresh fast, not pin a blocking
/// thread for two minutes.
const GH_VIEW_TIMEOUT: Duration = Duration::from_secs(60);

/// The `--json` field list for `gh pr view` — the exact shared-contract set the
/// status card renders.
const PR_VIEW_FIELDS: &str =
    "number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,statusCheckRollup";

/// A point-in-time snapshot of a task's GitHub PR for the status card. All
/// GitHub-vocabulary fields are plain strings passed through from `gh` (NO enum
/// fork — the UI degrades gracefully on values a newer GitHub introduces).
/// Deliberately carries NO timestamps: the web stamps receive-time locally.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrStatus.ts"))]
pub struct PrStatus {
    /// PR lifecycle state: `OPEN` | `CLOSED` | `MERGED` (gh vocabulary).
    pub state: String,
    /// Whether the PR is still a draft.
    pub is_draft: bool,
    /// Content mergeability: `MERGEABLE` | `CONFLICTING` | `UNKNOWN`.
    pub mergeable: String,
    /// Merge-box state: `CLEAN` | `BEHIND` | `BLOCKED` | `DIRTY` | `UNSTABLE` | ….
    pub merge_state_status: String,
    /// Review decision: `APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED`,
    /// or empty when the base branch requires no review.
    pub review_decision: String,
    /// Checks counted Rust-side from `statusCheckRollup` (see [`count_checks`]).
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_pending: u32,
    /// The PR's base branch on GitHub.
    pub base_ref_name: String,
    /// The gh-reported PR page URL (never the raw git remote URL, which can
    /// embed credentials and must not cross the IPC boundary).
    pub url: String,
    pub number: u64,
    /// LOCAL-only: commits on the task branch not on its upstream — computed
    /// from the worktree with no network; `0` when the worktree or upstream is
    /// gone. Non-zero means "Push updates" has something to publish.
    pub unpushed_commits: u32,
}

/// The deserialized shape of `gh pr view --json` output. Everything beyond the
/// identifying trio (`number`/`url`/`state`) is optional with a safe default,
/// so vocabulary/field drift across gh versions degrades a field — never the
/// whole snapshot.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPrView {
    number: u64,
    url: String,
    state: String,
    #[serde(default)]
    is_draft: Option<bool>,
    #[serde(default)]
    mergeable: Option<String>,
    #[serde(default)]
    merge_state_status: Option<String>,
    #[serde(default)]
    review_decision: Option<String>,
    #[serde(default)]
    base_ref_name: Option<String>,
    /// Kept as raw JSON: the entries come in TWO shapes (CheckRun vs
    /// StatusContext) whose fields drift across gh versions — [`count_checks`]
    /// classifies them tolerantly instead of a strict deserialization.
    #[serde(default)]
    status_check_rollup: Option<serde_json::Value>,
}

impl GhPrView {
    /// Map the gh view onto the wire contract, folding the rollup into counts
    /// and attaching the locally-computed unpushed count.
    fn into_status(self, unpushed_commits: u32) -> PrStatus {
        let (checks_passed, checks_failed, checks_pending) =
            count_checks(self.status_check_rollup.as_ref());
        PrStatus {
            state: self.state,
            is_draft: self.is_draft.unwrap_or(false),
            mergeable: self.mergeable.unwrap_or_default(),
            merge_state_status: self.merge_state_status.unwrap_or_default(),
            review_decision: self.review_decision.unwrap_or_default(),
            checks_passed,
            checks_failed,
            checks_pending,
            base_ref_name: self.base_ref_name.unwrap_or_default(),
            url: self.url,
            number: self.number,
            unpushed_commits,
        }
    }
}

/// One rollup entry's verdict (see [`classify_check`]).
enum CheckClass {
    Passed,
    Failed,
    Pending,
}

/// Count a `statusCheckRollup` array into `(passed, failed, pending)`. A null,
/// absent, or non-array rollup counts as all zeros (a PR with no checks).
fn count_checks(rollup: Option<&serde_json::Value>) -> (u32, u32, u32) {
    let Some(serde_json::Value::Array(items)) = rollup else {
        return (0, 0, 0);
    };
    let (mut passed, mut failed, mut pending) = (0u32, 0u32, 0u32);
    for item in items {
        match classify_check(item) {
            CheckClass::Passed => passed += 1,
            CheckClass::Failed => failed += 1,
            CheckClass::Pending => pending += 1,
        }
    }
    (passed, failed, pending)
}

/// Classify one rollup entry. The entries come in TWO shapes — a CheckRun
/// (`status` + `conclusion`) and a StatusContext (`state`) — and the vocabulary
/// drifts across gh/GitHub versions, so the mapping is deliberately tolerant:
/// only the enumerated pass/fail values count as such; EVERYTHING else
/// (unfinished runs, unknown strings, malformed entries) is *pending*, the
/// verdict that never overstates a green or a red. Matching is
/// case-insensitive (defence against casing drift).
fn classify_check(item: &serde_json::Value) -> CheckClass {
    let field = |key: &str| {
        item.get(key)
            .and_then(|v| v.as_str())
            .map(|v| v.to_ascii_uppercase())
    };
    // StatusContext shape: a `state` field.
    if let Some(state) = field("state") {
        return match state.as_str() {
            "SUCCESS" => CheckClass::Passed,
            "FAILURE" | "ERROR" => CheckClass::Failed,
            // PENDING / EXPECTED / anything a newer GitHub invents.
            _ => CheckClass::Pending,
        };
    }
    // CheckRun shape: a run that hasn't COMPLETED has no verdict yet, whatever
    // its conclusion field says.
    if let Some(status) = field("status") {
        if status != "COMPLETED" {
            return CheckClass::Pending; // QUEUED / IN_PROGRESS / WAITING / …
        }
    }
    match field("conclusion").as_deref() {
        Some("SUCCESS") | Some("NEUTRAL") | Some("SKIPPED") => CheckClass::Passed,
        Some("FAILURE")
        | Some("CANCELLED")
        | Some("TIMED_OUT")
        | Some("ACTION_REQUIRED")
        | Some("STARTUP_FAILURE") => CheckClass::Failed,
        // No conclusion, an unknown conclusion, or a malformed entry.
        _ => CheckClass::Pending,
    }
}

/// Run `gh pr view <number> --json …` in `dir` (bounded by `deadline`) and
/// deserialize it. Binary-parameterized — the injection seam the tests use to
/// exercise the real spawn path with a fake script (the phase-1 template).
fn fetch_pr_view_with(
    dir: &Path,
    binary: &str,
    number: u64,
    deadline: Duration,
) -> Result<GhPrView, String> {
    // Probe with `which` (PATHEXT-aware) so a missing gh reads as "install it",
    // and a spawn-time NotFound AFTER a green probe reads as the vanished-cwd
    // launch failure it actually is (run_gh_bounded's mapping) — never as a
    // missing tool.
    if which::which(binary).is_err() {
        return Err(
            "GitHub CLI (`gh`) is not installed — install it to track pull requests".to_string(),
        );
    }
    let number_arg = number.to_string();
    let out = run_gh_bounded(
        dir,
        binary,
        &["pr", "view", &number_arg, "--json", PR_VIEW_FIELDS],
        None,
        deadline,
        "timed out reading the pull request from GitHub — check your network and try again",
    )?;
    if !out.status.success() {
        let stderr = out.stderr.trim();
        return Err(if stderr.is_empty() {
            format!("`{binary} pr view` failed (exit {:?})", out.status.code())
        } else {
            // gh's stderr explains itself ("no pull requests found for …").
            stderr.to_string()
        });
    }
    serde_json::from_str(out.stdout.trim())
        .map_err(|e| format!("`{binary} pr view` returned unparseable JSON: {e}"))
}

/// The task's recorded PR number, or a clear refusal — the shared precondition
/// of the status read and the finalize. Pure.
fn require_pr_number(task: &Task) -> Result<u64, String> {
    task.pr_number
        .ok_or_else(|| "no PR is recorded for this task — create one first".to_string())
}

/// The push-updates precondition: the task must already carry a PR (the create
/// path is the only minter of `pr_url`, so this also implies worktree mode).
/// Pure.
fn check_push_preconditions(task: &Task) -> Result<(), String> {
    if task.pr_url.is_none() {
        return Err("no PR is recorded for this task — create one first".to_string());
    }
    Ok(())
}

/// Refuse a PR-lease action (push updates) while a sibling terminal action
/// (merge / commit) holds the task — the same cross-action discipline as PR
/// creation, checked AFTER the PR lease is acquired so whichever action leases
/// second reliably sees the other's lease.
fn refuse_push_while_sibling_in_flight(id: &str) -> Result<(), String> {
    if lease_held(merge_in_flight(), id) {
        return Err(
            "a merge for this task is in progress — wait for it to finish before pushing updates"
                .to_string(),
        );
    }
    if lease_held(commit_in_flight(), id) {
        return Err(
            "a commit for this task is in progress — wait for it to finish before pushing updates"
                .to_string(),
        );
    }
    Ok(())
}

/// Refuse a finalize while a PR action or commit holds the task — the mirror
/// checks for the merge-class lease `finalize_merged_pr` takes (its cleanup
/// deletes the worktree + branch, exactly what an in-flight push/commit is
/// standing in).
fn refuse_finalize_while_sibling_in_flight(id: &str) -> Result<(), String> {
    if lease_held(pr_in_flight(), id) {
        return Err(
            "a PR action for this task is in progress — wait for it to finish before finalizing"
                .to_string(),
        );
    }
    if lease_held(commit_in_flight(), id) {
        return Err(
            "a commit for this task is in progress — wait for it to finish before finalizing"
                .to_string(),
        );
    }
    Ok(())
}

/// Fetch the live GitHub status of a task's PR (see [`PrStatus`]). Read-only —
/// NO lease — and on-demand only (the UI fetches on mount + manual refresh;
/// there is no polling daemon). Requires `task.pr_number`.
#[tauri::command]
pub async fn pr_status(app: AppHandle, id: String) -> Result<PrStatus, String> {
    // `gh` talks to the network (up to 60s) plus local git reads — blocking work
    // that must not run on the UI thread (the WKWebView rule).
    tauri::async_runtime::spawn_blocking(move || pr_status_blocking(&app, &id))
        .await
        .map_err(|e| format!("PR status failed to run: {e}"))?
}

/// The blocking body of `pr_status` (see `commit_task_blocking` for the
/// state-reacquisition rationale behind the owned `AppHandle`).
fn pr_status_blocking(app: &AppHandle, id: &str) -> Result<PrStatus, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(app)?;
    let project_path = PathBuf::from(&project.path);
    let number = require_pr_number(&task)?;

    // cwd = the task's worktree when it still exists (config/credentials resolve
    // exactly as the user's own gh would there), else the project root — a
    // finalized/cleaned task can still refresh its PR state. The unpushed count
    // is local-only and needs the worktree; without one there is nothing
    // unpushed to report.
    let worktree_dir = worktree::worktree_path(&project_path, id);
    let (dir, unpushed_commits) = if worktree_dir.exists() {
        let unpushed = worktree::ahead_of_upstream(&worktree_dir);
        (worktree_dir, unpushed)
    } else {
        (project_path, 0)
    };
    let view = fetch_pr_view_with(&dir, GH_BINARY, number, GH_VIEW_TIMEOUT)?;
    Ok(view.into_status(unpushed_commits))
}

/// Re-push the task's branch to `origin` so an open PR picks up new local
/// commits. Plain push, NEVER `--force` (the phase-1 push, re-exposed) — and
/// void: the UI refetches [`pr_status`] afterwards for the fresh truth.
#[tauri::command]
pub async fn push_pr_updates(app: AppHandle, id: String) -> Result<(), String> {
    // The push talks to the network (up to 120s) — blocking-pool work.
    tauri::async_runtime::spawn_blocking(move || push_pr_updates_blocking(&app, &id))
        .await
        .map_err(|e| format!("push PR updates failed to run: {e}"))?
}

/// The blocking body of `push_pr_updates`: lease → cross-checks → preconditions
/// → bounded push.
fn push_pr_updates_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    // Same single-flight set as PR creation: one PR-arc push/create per task at
    // a time, and merges refuse while it is held (`refuse_while_pr_in_flight`).
    let _lease = TaskLease::acquire(pr_in_flight(), id)
        .ok_or_else(|| "a PR action for this task is already in progress".to_string())?;
    refuse_push_while_sibling_in_flight(id)?;
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(app)?;
    let project_path = PathBuf::from(&project.path);
    check_push_preconditions(&task)?;
    let worktree_dir = worktree::worktree_path(&project_path, id);
    if !worktree_dir.exists() {
        return Err(format!(
            "no worktree for task {id} — there is nothing local to push"
        ));
    }
    // Resolve the branch exactly like create does (task branch → `nc/<id>`) and
    // validate before it reaches any argv (push_branch re-validates too).
    let branch = task
        .branch
        .clone()
        .unwrap_or_else(|| worktree::branch_name(id));
    validate_ref(&branch)?;
    tracing::info!(target: "nightcore::pr", task_id = %id, branch = %branch, "pushing PR updates to origin");
    // Bounded (120s), plain, idempotent — the phase-1 push seam.
    worktree::push_branch(&worktree_dir, &branch)
}

/// Close out a task whose PR was merged ON GitHub: verify `state == MERGED`
/// server-side, refuse if unpushed local commits would be destroyed, then
/// mirror the local merge's post-merge tail — honor `cleanup_worktrees`, set
/// `merged`, emit `nc:task`.
#[tauri::command]
pub async fn finalize_merged_pr(app: AppHandle, id: String) -> Result<(), String> {
    // `gh` view (up to 60s) + git cleanup — blocking-pool work.
    tauri::async_runtime::spawn_blocking(move || finalize_merged_pr_blocking(&app, &id))
        .await
        .map_err(|e| format!("finalize merged PR failed to run: {e}"))?
}

/// The blocking body of `finalize_merged_pr`: lease → cross-checks → the
/// testable core → emit.
fn finalize_merged_pr_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    // Merge-class action: it takes the MERGE lease (its cleanup is the merge
    // tail), so a local merge and a finalize can never race on one task.
    let _lease = TaskLease::acquire(merge_in_flight(), id)
        .ok_or_else(|| "a merge for this task is already in progress".to_string())?;
    refuse_finalize_while_sibling_in_flight(id)?;
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let project = require_project(app)?;
    let project_path = PathBuf::from(&project.path);
    let cleanup = app
        .state::<SettingsStore>()
        .with_settings(|s| s.cleanup_worktrees);
    let updated = finalize_merged_core(&store, &project_path, id, GH_BINARY, cleanup)?;
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(())
}

/// The finalize core, `AppHandle`-free so the whole verify → refuse → cleanup →
/// persist arc is testable against a temp repo + fake gh: re-verify the PR is
/// MERGED on GitHub (never trust the caller — the UI's last status snapshot may
/// be stale or forged), refuse when the worktree holds unpushed commits
/// (`worktree::remove` is `--force`; cleanup would silently destroy them), then
/// the exact post-merge tail of `merge_task_blocking`.
fn finalize_merged_core(
    store: &TaskStore,
    project_path: &Path,
    id: &str,
    binary: &str,
    cleanup: bool,
) -> Result<Task, String> {
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let number = require_pr_number(&task)?;
    if task.merged {
        return Err("task is already merged — nothing to finalize".to_string());
    }

    // Server-side verification, from the worktree when it exists (else the
    // project root — same repo, same PR).
    let worktree_dir = worktree::worktree_path(project_path, id);
    let view_dir = if worktree_dir.exists() {
        worktree_dir.clone()
    } else {
        project_path.to_path_buf()
    };
    let view = fetch_pr_view_with(&view_dir, binary, number, GH_VIEW_TIMEOUT)?;
    if view.state != "MERGED" {
        return Err(format!(
            "PR #{number} is not merged on GitHub (state: {}) — merge it there first, or use the local merge",
            view.state
        ));
    }

    // Never destroy work: cleanup removes the worktree with `--force`, so local
    // commits that never reached the remote would be silently lost.
    if worktree_dir.exists() {
        let unpushed = worktree::ahead_of_upstream(&worktree_dir);
        if unpushed > 0 {
            return Err(format!(
                "the worktree has {unpushed} unpushed local commit(s) — push or discard them first"
            ));
        }
    }

    // The post-merge tail of `merge_task_blocking`, verbatim: best-effort
    // cleanup honoring the setting (off ⇒ the worktree persists until the user
    // merges/discards it), then the merged flag.
    if cleanup {
        let branch = task
            .branch
            .clone()
            .unwrap_or_else(|| worktree::branch_name(id));
        let _ = worktree::remove(project_path, id);
        let _ = worktree::delete_branch_named(project_path, &branch);
    }
    tracing::info!(target: "nightcore::pr", task_id = %id, pr_number = number, cleaned_up = cleanup, "finalized remotely-merged PR");
    store.mutate(id, |t| {
        t.merged = true;
        t.conflict = false;
    })
}

/// Per-task single-flight guard for the base pull — its own action set (the
/// `pr_in_flight` pattern): a double-fired pull must not race two fetches +
/// ff-merges on the project root.
fn pull_in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Fast-forward-only pull of the task's base branch on the PROJECT ROOT, for
/// after a remote merge: `git fetch origin <base>` + `git merge --ff-only
/// origin/<base>`. Refuses a dirty root and a root not checked out on the base;
/// a non-ff base surfaces git's error verbatim — NEVER a real merge.
#[tauri::command]
pub async fn pull_base_ff(app: AppHandle, id: String) -> Result<(), String> {
    // The fetch talks to the network (up to 120s) — blocking-pool work.
    tauri::async_runtime::spawn_blocking(move || pull_base_ff_blocking(&app, &id))
        .await
        .map_err(|e| format!("pull base failed to run: {e}"))?
}

/// The blocking body of `pull_base_ff`: lease → resolve the base → the testable
/// core.
fn pull_base_ff_blocking(app: &AppHandle, id: &str) -> Result<(), String> {
    let _lease = TaskLease::acquire(pull_in_flight(), id)
        .ok_or_else(|| "a base pull for this task is already in progress".to_string())?;
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(app)?;
    let project_path = PathBuf::from(&project.path);
    // The base resolves like merge/create do: the task's stored base, else the
    // project's current branch.
    let base = task
        .base_branch
        .clone()
        .unwrap_or_else(|| worktree::base_branch(&project_path));
    tracing::info!(target: "nightcore::pr", task_id = %id, base = %base, "fast-forwarding base from origin");
    pull_base_ff_core(&project_path, &base)
}

/// The pull core, `AppHandle`-free and unit-tested against a real temp repo
/// pair: validate → refuse a dirty root → refuse a root not on `base` (STRICT
/// current-branch read; a detached HEAD refuses rather than guessing) → bounded
/// fetch → ff-only merge (failure verbatim).
fn pull_base_ff_core(project_path: &Path, base: &str) -> Result<(), String> {
    validate_ref(base)?;
    if !worktree::is_worktree_clean(project_path)? {
        return Err(
            "project has uncommitted changes — commit or stash them before pulling the base"
                .to_string(),
        );
    }
    match worktree::current_branch(project_path) {
        Some(current) if current == base => {}
        Some(current) => {
            return Err(format!(
                "the project is checked out on `{current}`, not the base `{base}` — check out the base before pulling"
            ));
        }
        None => {
            return Err(format!(
                "the project is not on a named branch (detached HEAD) — check out `{base}` before pulling"
            ));
        }
    }
    worktree::fetch_base(project_path, base)?;
    worktree::merge_ff_only(project_path, base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::RunMode;
    use serde_json::json;
    use std::path::PathBuf;
    use std::process::Command;

    // ── Pure classification ────────────────────────────────────────────────

    #[test]
    fn count_checks_classifies_both_rollup_shapes_tolerantly() {
        // The most drift-prone parse in the feature: CheckRun (status +
        // conclusion) and StatusContext (state) entries, mixed, with unknown
        // vocabulary and malformed entries degrading to PENDING — the verdict
        // that never overstates a green or a red.
        let rollup = json!([
            // CheckRun passes.
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "NEUTRAL"},
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SKIPPED"},
            // CheckRun failures.
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE"},
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "CANCELLED"},
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "TIMED_OUT"},
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "ACTION_REQUIRED"},
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "STARTUP_FAILURE"},
            // CheckRun pendings: not completed (whatever conclusion says),
            // null/absent conclusion, unknown conclusion vocabulary.
            {"__typename": "CheckRun", "status": "IN_PROGRESS", "conclusion": null},
            {"__typename": "CheckRun", "status": "QUEUED"},
            {"__typename": "CheckRun", "status": "WAITING", "conclusion": "SUCCESS"},
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": null},
            {"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SOME_NEW_VERDICT"},
            // StatusContext: pass / fails / pendings / unknown.
            {"__typename": "StatusContext", "state": "SUCCESS"},
            {"__typename": "StatusContext", "state": "FAILURE"},
            {"__typename": "StatusContext", "state": "ERROR"},
            {"__typename": "StatusContext", "state": "PENDING"},
            {"__typename": "StatusContext", "state": "EXPECTED"},
            {"__typename": "StatusContext", "state": "SOME_NEW_STATE"},
            // Malformed entries degrade to pending, never a crash.
            {},
            "not an object",
        ]);
        assert_eq!(count_checks(Some(&rollup)), (4, 7, 10));
    }

    #[test]
    fn count_checks_is_case_insensitive_against_casing_drift() {
        let rollup = json!([
            {"status": "completed", "conclusion": "success"},
            {"state": "failure"},
        ]);
        assert_eq!(count_checks(Some(&rollup)), (1, 1, 0));
    }

    #[test]
    fn count_checks_treats_missing_null_or_nonarray_rollup_as_zero() {
        // A PR with no checks: gh emits null or omits the field entirely.
        assert_eq!(count_checks(None), (0, 0, 0));
        assert_eq!(count_checks(Some(&json!(null))), (0, 0, 0));
        assert_eq!(count_checks(Some(&json!([]))), (0, 0, 0));
        // A non-array shape (future drift) degrades to zeros, never a crash.
        assert_eq!(count_checks(Some(&json!({"weird": true}))), (0, 0, 0));
        assert_eq!(count_checks(Some(&json!("weird"))), (0, 0, 0));
    }

    #[test]
    fn gh_view_deserializes_minimal_and_null_padded_payloads() {
        // Only the identifying trio is required; every other field may be
        // absent OR null across gh versions and degrades to a safe default.
        let minimal: GhPrView =
            serde_json::from_str(r#"{"number":7,"url":"https://x/pull/7","state":"OPEN"}"#)
                .expect("minimal view parses");
        let status = minimal.into_status(2);
        assert_eq!(status.number, 7);
        assert_eq!(status.state, "OPEN");
        assert!(!status.is_draft);
        assert_eq!(status.mergeable, "");
        assert_eq!(status.merge_state_status, "");
        assert_eq!(status.review_decision, "");
        assert_eq!(status.base_ref_name, "");
        assert_eq!(
            (
                status.checks_passed,
                status.checks_failed,
                status.checks_pending
            ),
            (0, 0, 0)
        );
        assert_eq!(status.unpushed_commits, 2, "the local count passes through");

        let padded: GhPrView = serde_json::from_str(
            r#"{"number":8,"url":"https://x/pull/8","state":"MERGED","isDraft":null,
                "mergeable":null,"mergeStateStatus":null,"reviewDecision":null,
                "baseRefName":null,"statusCheckRollup":null}"#,
        )
        .expect("null-padded view parses");
        assert_eq!(padded.into_status(0).state, "MERGED");
    }

    #[test]
    fn pr_status_serializes_camel_case() {
        // The wire contract the web builds against: camelCase keys, plain
        // strings, no timestamps.
        let status = GhPrView {
            number: 12,
            url: "https://github.com/a/b/pull/12".into(),
            state: "OPEN".into(),
            is_draft: Some(true),
            mergeable: Some("MERGEABLE".into()),
            merge_state_status: Some("CLEAN".into()),
            review_decision: Some("APPROVED".into()),
            base_ref_name: Some("main".into()),
            status_check_rollup: None,
        }
        .into_status(4);
        let json = serde_json::to_string(&status).expect("serialize");
        for key in [
            r#""state":"OPEN""#,
            r#""isDraft":true"#,
            r#""mergeable":"MERGEABLE""#,
            r#""mergeStateStatus":"CLEAN""#,
            r#""reviewDecision":"APPROVED""#,
            r#""checksPassed":0"#,
            r#""checksFailed":0"#,
            r#""checksPending":0"#,
            r#""baseRefName":"main""#,
            r#""number":12"#,
            r#""unpushedCommits":4"#,
        ] {
            assert!(json.contains(key), "wire shape carries {key}: {json}");
        }
    }

    // ── Preconditions + lease cross-checks ─────────────────────────────────

    #[test]
    fn require_pr_number_refuses_a_task_without_one() {
        let task = Task::new("t".into(), String::new());
        let err = require_pr_number(&task).expect_err("no PR number is refused");
        assert!(err.contains("no PR"), "explains the refusal: {err}");

        let mut with = Task::new("t".into(), String::new());
        with.pr_number = Some(7);
        assert_eq!(require_pr_number(&with), Ok(7));
    }

    #[test]
    fn push_preconditions_require_an_existing_pr() {
        let task = Task::new("t".into(), String::new()).with_run_mode(RunMode::Worktree);
        let err = check_push_preconditions(&task).expect_err("no PR is refused");
        assert!(err.contains("no PR"), "explains the refusal: {err}");

        let mut with = task.clone();
        with.pr_url = Some("https://github.com/a/b/pull/7".into());
        assert!(check_push_preconditions(&with).is_ok());
    }

    #[test]
    fn push_updates_refused_while_merge_or_commit_holds_the_task() {
        // Merge direction: a completing merge deletes the worktree/branch out
        // from under an in-flight push. Unique ids: the sets are global.
        let merge_lease =
            TaskLease::acquire(merge_in_flight(), "push-vs-merge").expect("merge lease");
        let err =
            refuse_push_while_sibling_in_flight("push-vs-merge").expect_err("push is refused");
        assert!(err.contains("merge"), "names the conflicting action: {err}");
        drop(merge_lease);
        assert!(refuse_push_while_sibling_in_flight("push-vs-merge").is_ok());

        // Commit direction: the push would race the in-progress stage/commit.
        let commit_lease =
            TaskLease::acquire(commit_in_flight(), "push-vs-commit").expect("commit lease");
        let err =
            refuse_push_while_sibling_in_flight("push-vs-commit").expect_err("push is refused");
        assert!(
            err.contains("commit"),
            "names the conflicting action: {err}"
        );
        // Other tasks are unaffected, and dropping the lease frees this one.
        assert!(refuse_push_while_sibling_in_flight("push-vs-commit-other").is_ok());
        drop(commit_lease);
        assert!(refuse_push_while_sibling_in_flight("push-vs-commit").is_ok());
    }

    #[test]
    fn finalize_refused_while_pr_or_commit_holds_the_task() {
        // PR direction: finalize's cleanup would delete the worktree under an
        // in-flight push/create.
        let pr_lease = TaskLease::acquire(pr_in_flight(), "fin-vs-pr").expect("pr lease");
        let err =
            refuse_finalize_while_sibling_in_flight("fin-vs-pr").expect_err("finalize is refused");
        assert!(err.contains("PR"), "names the conflicting action: {err}");
        drop(pr_lease);
        assert!(refuse_finalize_while_sibling_in_flight("fin-vs-pr").is_ok());

        // Commit direction.
        let commit_lease =
            TaskLease::acquire(commit_in_flight(), "fin-vs-commit").expect("commit lease");
        let err = refuse_finalize_while_sibling_in_flight("fin-vs-commit")
            .expect_err("finalize is refused");
        assert!(
            err.contains("commit"),
            "names the conflicting action: {err}"
        );
        drop(commit_lease);
        assert!(refuse_finalize_while_sibling_in_flight("fin-vs-commit").is_ok());
    }

    #[test]
    fn pull_lease_is_single_flight_and_independent() {
        let first = TaskLease::acquire(pull_in_flight(), "pull-x").expect("first acquire");
        assert!(
            TaskLease::acquire(pull_in_flight(), "pull-x").is_none(),
            "a second concurrent pull on the same task is refused"
        );
        assert!(
            TaskLease::acquire(pull_in_flight(), "pull-y").is_some(),
            "a different task is unaffected"
        );
        drop(first);
        assert!(
            TaskLease::acquire(pull_in_flight(), "pull-x").is_some(),
            "dropping the lease frees the task"
        );
    }

    // ── Fixtures (the phase-1 fake-gh + temp-repo patterns) ────────────────

    /// Write an executable shell script into `dir` to stand in for `gh`, so
    /// the tests exercise the real spawn + exit-code mapping (not a mock).
    #[cfg(unix)]
    fn fake_gh(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-gh.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
        let mut perms = std::fs::metadata(&path)
            .expect("script metadata")
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod script");
        path
    }

    /// A one-line fake-gh body that prints a `gh pr view`-shaped payload for
    /// PR `number` in `state`.
    #[cfg(unix)]
    fn view_json(number: u64, state: &str) -> String {
        format!(
            "echo '{{\"number\":{number},\"url\":\"https://github.com/acme/widget/pull/{number}\",\
             \"state\":\"{state}\",\"isDraft\":false,\"mergeable\":\"UNKNOWN\",\
             \"mergeStateStatus\":\"UNKNOWN\",\"reviewDecision\":\"\",\"baseRefName\":\"main\",\
             \"statusCheckRollup\":[]}}'"
        )
    }

    /// Build a real git repo with one commit (the worktree-tests fixture).
    /// `None` (skipping the test) when `git` is unavailable.
    fn temp_repo() -> Option<(tempfile::TempDir, PathBuf)> {
        let tmp = tempfile::TempDir::new().ok()?;
        let path = tmp.path().to_path_buf();
        if !run_in(&path, &["init", "-q"]) {
            return None;
        }
        run_in(&path, &["config", "user.email", "t@t.t"]);
        run_in(&path, &["config", "user.name", "t"]);
        std::fs::write(path.join(".gitignore"), ".nightcore/\n").ok()?;
        std::fs::write(path.join("README.md"), "hi").ok()?;
        run_in(&path, &["add", "."]);
        if !run_in(&path, &["commit", "-q", "-m", "init"]) {
            return None;
        }
        Some((tmp, path))
    }

    /// Run a git command in `dir` for tests, returning success.
    fn run_in(dir: &Path, args: &[&str]) -> bool {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// A bare repo standing in for `origin`, wired into `repo` — so pushes and
    /// fetches need no network.
    fn add_bare_origin(repo: &Path) -> Option<tempfile::TempDir> {
        let bare = tempfile::TempDir::new().ok()?;
        let ok = Command::new("git")
            .args(["init", "-q", "--bare"])
            .current_dir(bare.path())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok || !run_in(repo, &["remote", "add", "origin", bare.path().to_str()?]) {
            return None;
        }
        Some(bare)
    }

    /// A store rooted at a fresh temp dir + a seeded worktree-mode task that
    /// carries a PR (the finalize fixture).
    fn seed_pr_task(pr_number: u64) -> (TaskStore, tempfile::TempDir, String) {
        let tmp = tempfile::TempDir::new().expect("store dir");
        let store = TaskStore::load_from(tmp.path().join("tasks"));
        let mut task =
            Task::new("Add login".into(), "OAuth".into()).with_run_mode(RunMode::Worktree);
        task.committed = true;
        task.verified = true;
        task.pr_url = Some(format!("https://github.com/acme/widget/pull/{pr_number}"));
        task.pr_number = Some(pr_number);
        let id = task.id.clone();
        store.upsert(&task).expect("seed task");
        (store, tmp, id)
    }

    // ── fetch_pr_view_with (the bounded gh seam) ───────────────────────────

    #[test]
    #[cfg(unix)]
    fn fetch_pr_view_parses_a_success_and_carries_the_contract_argv() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let body = "printf '%s\\n' \"$@\" > args.txt\n\
             echo '{\"number\":42,\"url\":\"https://github.com/acme/widget/pull/42\",\
             \"state\":\"OPEN\",\"isDraft\":true,\"mergeable\":\"MERGEABLE\",\
             \"mergeStateStatus\":\"BLOCKED\",\"reviewDecision\":\"REVIEW_REQUIRED\",\
             \"baseRefName\":\"develop\",\"statusCheckRollup\":[\
             {\"status\":\"COMPLETED\",\"conclusion\":\"SUCCESS\"},\
             {\"state\":\"FAILURE\"},\
             {\"status\":\"IN_PROGRESS\"}]}'";
        let script = fake_gh(tmp.path(), body);
        let view = fetch_pr_view_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            42,
            Duration::from_secs(10),
        )
        .expect("view parses");
        let status = view.into_status(5);
        assert_eq!(status.number, 42);
        assert_eq!(status.state, "OPEN");
        assert!(status.is_draft);
        assert_eq!(status.mergeable, "MERGEABLE");
        assert_eq!(status.merge_state_status, "BLOCKED");
        assert_eq!(status.review_decision, "REVIEW_REQUIRED");
        assert_eq!(status.base_ref_name, "develop");
        assert_eq!(
            (
                status.checks_passed,
                status.checks_failed,
                status.checks_pending
            ),
            (1, 1, 1),
            "the rollup was counted Rust-side"
        );
        assert_eq!(status.unpushed_commits, 5);

        // The argv carries the contract: `pr view <n> --json <field list>`.
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args.txt");
        let args: Vec<&str> = args.lines().collect();
        for expected in ["pr", "view", "42", "--json", PR_VIEW_FIELDS] {
            assert!(
                args.contains(&expected),
                "argv missing {expected}: {args:?}"
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn fetch_pr_view_surfaces_stderr_verbatim_on_failure() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "echo 'no pull requests found for branch \"nc/t-1\"' >&2\nexit 1",
        );
        let err = fetch_pr_view_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            42,
            Duration::from_secs(10),
        )
        .expect_err("a non-zero exit maps to Err");
        assert!(
            err.contains("no pull requests found"),
            "gh's stderr is verbatim: {err}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn fetch_pr_view_reports_malformed_json_loudly() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(tmp.path(), "echo 'this is not json'");
        let err = fetch_pr_view_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            42,
            Duration::from_secs(10),
        )
        .expect_err("garbage output maps to Err");
        assert!(err.contains("unparseable JSON"), "names the failure: {err}");
    }

    #[test]
    #[cfg(unix)]
    fn fetch_pr_view_times_out_a_hung_gh() {
        // A black-holed GitHub must error out under the deadline, not pin the
        // blocking thread. The deadline is injectable, so the test stays fast.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(tmp.path(), "sleep 30");
        let start = std::time::Instant::now();
        let err = fetch_pr_view_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            42,
            Duration::from_millis(200),
        )
        .expect_err("an overrunning gh times out");
        assert!(err.contains("timed out"), "names the timeout: {err}");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "the kill returns promptly, not after the child's sleep"
        );
    }

    #[test]
    fn fetch_pr_view_reports_a_missing_gh_as_install_guidance() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let err = fetch_pr_view_with(
            tmp.path(),
            "definitely-not-a-real-binary-xyz",
            42,
            Duration::from_secs(1),
        )
        .expect_err("a missing gh is refused");
        assert!(
            err.contains("not installed"),
            "points at the install: {err}"
        );
    }

    // ── finalize_merged_core (temp repo + bare origin + fake gh) ───────────

    #[test]
    #[cfg(unix)]
    fn finalize_marks_merged_and_cleans_up_when_the_setting_is_on() {
        let Some((_tmp, repo)) = temp_repo() else {
            return; // git unavailable
        };
        let Some(_bare) = add_bare_origin(&repo) else {
            return;
        };
        let (store, _store_tmp, id) = seed_pr_task(7);
        let dir = worktree::allocate(&repo, &id).expect("allocate");
        std::fs::write(dir.join("f.txt"), "x").expect("write");
        worktree::commit(&repo, &id, "work").expect("commit");
        let branch = worktree::branch_name(&id);
        worktree::push_branch(&dir, &branch).expect("push");

        // The fake gh lives OUTSIDE the repo so it never dirties the worktree.
        let script_dir = tempfile::TempDir::new().expect("script dir");
        let script = fake_gh(script_dir.path(), &view_json(7, "MERGED"));

        let updated = finalize_merged_core(&store, &repo, &id, script.to_str().unwrap(), true)
            .expect("finalize succeeds");
        assert!(updated.merged, "the returned task is merged");
        assert!(!updated.conflict);
        assert!(
            store.get(&id).expect("task").merged,
            "the merged flag is PERSISTED via the store, not just returned"
        );
        assert!(!dir.exists(), "cleanup=on removed the worktree");
        assert!(
            !run_in(
                &repo,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    "--end-of-options",
                    &branch
                ],
            ),
            "cleanup=on deleted the branch"
        );
    }

    #[test]
    #[cfg(unix)]
    fn finalize_keeps_the_worktree_when_cleanup_is_off() {
        // Exact parity with the local merge: cleanup_worktrees=false keeps the
        // worktree + branch for inspection until merge/discard.
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let Some(_bare) = add_bare_origin(&repo) else {
            return;
        };
        let (store, _store_tmp, id) = seed_pr_task(7);
        let dir = worktree::allocate(&repo, &id).expect("allocate");
        std::fs::write(dir.join("f.txt"), "x").expect("write");
        worktree::commit(&repo, &id, "work").expect("commit");
        let branch = worktree::branch_name(&id);
        worktree::push_branch(&dir, &branch).expect("push");

        let script_dir = tempfile::TempDir::new().expect("script dir");
        let script = fake_gh(script_dir.path(), &view_json(7, "MERGED"));

        let updated = finalize_merged_core(&store, &repo, &id, script.to_str().unwrap(), false)
            .expect("finalize succeeds");
        assert!(updated.merged);
        assert!(dir.exists(), "cleanup=off keeps the worktree");
        assert!(
            run_in(
                &repo,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    "--end-of-options",
                    &branch
                ],
            ),
            "cleanup=off keeps the branch"
        );
    }

    #[test]
    #[cfg(unix)]
    fn finalize_refuses_a_pr_that_is_not_merged_on_github() {
        // The server-side verification: the caller's claim is never trusted —
        // an OPEN PR refuses, and nothing local changes.
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let Some(_bare) = add_bare_origin(&repo) else {
            return;
        };
        let (store, _store_tmp, id) = seed_pr_task(7);
        let dir = worktree::allocate(&repo, &id).expect("allocate");
        std::fs::write(dir.join("f.txt"), "x").expect("write");
        worktree::commit(&repo, &id, "work").expect("commit");
        worktree::push_branch(&dir, &worktree::branch_name(&id)).expect("push");

        let script_dir = tempfile::TempDir::new().expect("script dir");
        let script = fake_gh(script_dir.path(), &view_json(7, "OPEN"));

        let err = finalize_merged_core(&store, &repo, &id, script.to_str().unwrap(), true)
            .expect_err("an OPEN PR must refuse to finalize");
        assert!(err.contains("not merged"), "explains the refusal: {err}");
        assert!(err.contains("OPEN"), "names the actual state: {err}");
        assert!(!store.get(&id).expect("task").merged, "task untouched");
        assert!(dir.exists(), "the worktree was not cleaned up");
    }

    #[test]
    #[cfg(unix)]
    fn finalize_refuses_when_unpushed_local_commits_would_be_destroyed() {
        // worktree::remove is `--force`: a local commit that never reached the
        // remote would be silently destroyed by cleanup. Refuse it, even when
        // GitHub says MERGED.
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let Some(_bare) = add_bare_origin(&repo) else {
            return;
        };
        let (store, _store_tmp, id) = seed_pr_task(7);
        let dir = worktree::allocate(&repo, &id).expect("allocate");
        std::fs::write(dir.join("f.txt"), "x").expect("write");
        worktree::commit(&repo, &id, "work").expect("commit");
        worktree::push_branch(&dir, &worktree::branch_name(&id)).expect("push");
        // A second commit that is NOT pushed.
        std::fs::write(dir.join("late-fix.txt"), "y").expect("write");
        worktree::commit(&repo, &id, "late fix").expect("commit 2");

        let script_dir = tempfile::TempDir::new().expect("script dir");
        let script = fake_gh(script_dir.path(), &view_json(7, "MERGED"));

        let err = finalize_merged_core(&store, &repo, &id, script.to_str().unwrap(), true)
            .expect_err("unpushed commits must refuse to finalize");
        assert!(err.contains("unpushed"), "explains the refusal: {err}");
        assert!(dir.exists(), "the worktree (and its commits) survive");
        assert!(!store.get(&id).expect("task").merged, "task untouched");
    }

    #[test]
    fn finalize_refuses_without_a_pr_number_and_when_already_merged() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        // No PR recorded.
        let tmp = tempfile::TempDir::new().expect("store dir");
        let store = TaskStore::load_from(tmp.path().join("tasks"));
        let task = Task::new("t".into(), String::new()).with_run_mode(RunMode::Worktree);
        let id = task.id.clone();
        store.upsert(&task).expect("seed");
        let err = finalize_merged_core(&store, &repo, &id, "gh-unused", true)
            .expect_err("no PR number is refused");
        assert!(err.contains("no PR"), "explains the refusal: {err}");

        // Already merged: nothing to finalize (and no gh spawn happens — the
        // binary name is deliberately bogus).
        let (store, _store_tmp, id) = seed_pr_task(7);
        store.mutate(&id, |t| t.merged = true).expect("mark merged");
        let err = finalize_merged_core(&store, &repo, &id, "gh-unused", true)
            .expect_err("already merged is refused");
        assert!(err.contains("already merged"), "explains: {err}");
    }

    // ── pull_base_ff_core (real temp repo pair) ────────────────────────────

    #[test]
    fn pull_base_ff_fast_forwards_then_refuses_a_diverged_base() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let Some(_bare) = add_bare_origin(&repo) else {
            return;
        };
        let base = worktree::current_branch(&repo).expect("a named branch");
        worktree::push_branch(&repo, &base).expect("push base");

        // Advance origin one commit past the local base: commit + push, then
        // rewind the local branch (the remote-tracking ref stays ahead).
        std::fs::write(repo.join("second.txt"), "2").expect("write");
        run_in(&repo, &["add", "."]);
        assert!(run_in(&repo, &["commit", "-q", "-m", "second"]));
        worktree::push_branch(&repo, &base).expect("push second");
        assert!(run_in(&repo, &["reset", "--hard", "-q", "HEAD~1"]));
        assert!(!repo.join("second.txt").exists(), "local base rewound");

        pull_base_ff_core(&repo, &base).expect("a clean fast-forward succeeds");
        assert!(
            repo.join("second.txt").exists(),
            "the base fast-forwarded to origin"
        );

        // Diverge: rewind again and commit DIFFERENT content locally. ff-only
        // must fail (git's error verbatim) and never fall back to a real merge.
        assert!(run_in(&repo, &["reset", "--hard", "-q", "HEAD~1"]));
        std::fs::write(repo.join("local.txt"), "l").expect("write");
        run_in(&repo, &["add", "."]);
        assert!(run_in(&repo, &["commit", "-q", "-m", "diverge"]));
        let err = pull_base_ff_core(&repo, &base).expect_err("a diverged base must not ff");
        assert!(!err.is_empty(), "git's ff-only failure surfaces");
        assert!(
            repo.join("local.txt").exists() && !repo.join("second.txt").exists(),
            "no merge happened — the local branch is untouched"
        );
        assert!(
            worktree::is_worktree_clean(&repo).expect("status"),
            "the failed ff leaves a clean tree (no mid-merge state)"
        );
    }

    #[test]
    fn pull_base_ff_refuses_a_dirty_root() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let base = worktree::current_branch(&repo).expect("a named branch");
        std::fs::write(repo.join("README.md"), "dirty edit").expect("write");
        let err = pull_base_ff_core(&repo, &base).expect_err("a dirty root is refused");
        assert!(
            err.contains("uncommitted changes"),
            "explains the refusal: {err}"
        );
    }

    #[test]
    fn pull_base_ff_refuses_when_the_root_is_not_on_the_base() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        let base = worktree::current_branch(&repo).expect("a named branch");
        assert!(run_in(
            &repo,
            &["checkout", "-q", "-b", "feature/elsewhere"]
        ));
        let err = pull_base_ff_core(&repo, &base).expect_err("a wrong branch is refused");
        assert!(
            err.contains("feature/elsewhere") && err.contains(&base),
            "names both branches: {err}"
        );

        // Detached HEAD refuses too (never guess the branch).
        assert!(run_in(&repo, &["checkout", "-q", "--detach"]));
        let err = pull_base_ff_core(&repo, &base).expect_err("detached HEAD is refused");
        assert!(err.contains("detached"), "explains the refusal: {err}");
    }

    #[test]
    fn pull_base_ff_rejects_injection_bases_before_any_git_spawn() {
        let Some((_tmp, repo)) = temp_repo() else {
            return;
        };
        for bad in ["--force", "-D", "a..b"] {
            let err = pull_base_ff_core(&repo, bad).expect_err("a hostile base is rejected");
            assert!(
                err.contains("invalid branch/base name"),
                "validate_ref rejection: {err}"
            );
        }
    }
}
