//! Create-PR workflow (PR arc, phase 1 — design doc §3.1).
//!
//! The deterministic publish path beside the local merge: probe capability
//! ([`pr_support`]), draft an editable title/body ([`draft_pr_message`]), then
//! push the task's worktree branch and open a GitHub PR ([`create_pr_task`]).
//! `gh` is the GitHub seam — user-installed, `which`-probed, never bundled (the
//! `claude` / gitleaks precedent); `gh` owns auth, Nightcore stores no tokens.
//! Absent `gh` or no `origin` remote ⇒ the capability is reported off and the UI
//! never shows the button, rather than failing on click.
//!
//! Safety posture:
//! - **Same bar as merge.** A PR is a publish; it requires a worktree-mode task
//!   that is committed AND verified, plus a passing readiness + structure-lock
//!   gauntlet — never a side door around the gates.
//! - **argv hygiene.** Every ref goes through `validate_ref` (and the push call
//!   site adds `--end-of-options`); the PR body travels on **stdin**, never argv
//!   (length + injection). Plain `git push` only — NEVER `--force`.
//! - **Re-runnable.** A failure between push and create is safe: the push is
//!   idempotent and `gh` errors loudly (verbatim to the user) when a PR already
//!   exists for the branch.
//! - **[`open_external`] is https-only** so a stored URL can never launch a
//!   local resource or script through the browser seam.

use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
// ts-rs is a dev-dependency (the Rust→TS codegen runs under `cargo test` only).
#[cfg(test)]
use ts_rs::TS;

use super::merge::{require_project, TaskLease};
use super::pr_msg;
use crate::gauntlet;
use crate::gauntlet_project;
use crate::store::TaskStore;
use crate::task::{Task, TASK_EVENT};
use crate::worktree::{self, validate_ref};

/// The GitHub CLI binary name — the production argument to the binary-
/// parameterized seams below (tests inject fake scripts instead). Shared with
/// the phase-2 status/finalize commands (`pr_status.rs`).
pub(super) const GH_BINARY: &str = "gh";

/// Wall-clock bound on every network-facing `gh` spawn (create + view). Same
/// rationale as the push deadline: generous, but finite — a black-holed GitHub
/// must error out, not pin the blocking thread + PR lease with the dialog stuck
/// on "Creating…".
const GH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Whether the machine can create PRs for the active project: `gh` on PATH and
/// an `origin` remote configured. Sent to the UI so the Create PR button gates
/// honestly instead of failing on click. Booleans ONLY — the raw remote URL can
/// embed credentials (`https://user:token@host/…`) and must never cross the IPC
/// boundary into the renderer.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrSupport.ts"))]
pub struct PrSupport {
    /// `which`-probed presence of the GitHub CLI.
    pub gh_installed: bool,
    /// Whether the project has an `origin` remote configured (the URL itself
    /// stays on the Rust side — it may carry embedded credentials).
    pub has_remote: bool,
}

/// An AI-drafted (or deterministically fallen-back) PR title + markdown body,
/// pre-filled into the editable create dialog — never posted directly.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrDraft.ts"))]
pub struct PrDraft {
    pub title: String,
    pub body: String,
}

/// Probe PR capability for the active project (see [`PrSupport`]). The `id` is
/// part of the shared command contract (the bridge always sends the task id);
/// the probe itself is project-scoped. Runs off the UI thread — the remote read
/// spawns `git`.
#[tauri::command]
pub async fn pr_support(app: AppHandle, id: String) -> Result<PrSupport, String> {
    tauri::async_runtime::spawn_blocking(move || pr_support_blocking(&app, &id))
        .await
        .map_err(|e| format!("PR support probe failed to run: {e}"))?
}

/// The blocking body of `pr_support` (see `commit_task_blocking` for the
/// state-reacquisition rationale behind the owned `AppHandle`).
fn pr_support_blocking(app: &AppHandle, id: &str) -> Result<PrSupport, String> {
    tracing::debug!(target: "nightcore::pr", task_id = %id, "probing PR support");
    let project = require_project(app)?;
    let project_path = std::path::PathBuf::from(&project.path);
    Ok(PrSupport {
        gh_installed: which::which(GH_BINARY).is_ok(),
        has_remote: worktree::remote_url(&project_path).is_some(),
    })
}

/// Draft a PR title/body for a task via the `claude -p` one-shot
/// ([`pr_msg::draft_for`]), falling back to the deterministic pair (task title +
/// task description) on any failure — the command itself never errors on a
/// drafting failure, only on a missing task/project or an invalid `base`. Run
/// when the create dialog opens, so `create_pr_task` never blocks on `claude`.
/// `base` lets the dialog RE-draft against a picker-chosen base (the draft
/// describes `git diff <base>...HEAD`, so a base switch changes the facts);
/// `None` keeps the default resolution (task base → project branch).
#[tauri::command]
pub async fn draft_pr_message(
    app: AppHandle,
    id: String,
    base: Option<String>,
) -> Result<PrDraft, String> {
    // The drafting pass spawns `claude -p` (up to a 30s timeout) plus git reads —
    // blocking work that must not run on the UI thread (the WKWebView rule).
    tauri::async_runtime::spawn_blocking(move || draft_pr_message_blocking(&app, &id, base))
        .await
        .map_err(|e| format!("PR message drafting failed to run: {e}"))?
}

/// The blocking body of `draft_pr_message`.
fn draft_pr_message_blocking(
    app: &AppHandle,
    id: &str,
    base_arg: Option<String>,
) -> Result<PrDraft, String> {
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(app)?;
    let project_path = std::path::PathBuf::from(&project.path);
    let dir = worktree::worktree_path(&project_path, id);
    let base = resolve_draft_base(base_arg, task.base_branch.clone(), || {
        worktree::base_branch(&project_path)
    })?;
    let drafted = if dir.exists() {
        pr_msg::draft_for(&store, &dir, &task, &base)
    } else {
        None
    };
    Ok(drafted.unwrap_or_else(|| PrDraft {
        title: task.title.clone(),
        body: task.description.clone(),
    }))
}

/// Resolve the base a draft is computed against: an explicit picker base wins
/// (validated — it reaches `git diff` argv inside `draft_for`), else the task's
/// stored base, else the project's current branch. A blank/whitespace explicit
/// base counts as "not provided". Pure, unit-testable.
fn resolve_draft_base(
    base_arg: Option<String>,
    task_base: Option<String>,
    project_base: impl FnOnce() -> String,
) -> Result<String, String> {
    match base_arg.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => {
            validate_ref(b)?;
            Ok(b.to_string())
        }
        None => Ok(task_base.unwrap_or_else(project_base)),
    }
}

/// Per-task single-flight guard for PR creation (the pattern of
/// `commit_in_flight`/`merge_in_flight` in [`super::merge`]): a double-fired
/// command must not race two pushes + two `gh pr create` runs for one task.
/// `pub(crate)` so `merge_task_blocking` can refuse while a creation is live.
pub(crate) fn pr_in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Refuse PR creation while a sibling terminal action (merge / commit) holds
/// the task. The three in-flight sets are per-action, so without this a merge
/// and a create-PR could run concurrently on one task — and a completing merge
/// (with `cleanup_worktrees` on) deletes the worktree + branch out from under
/// the in-flight push/`gh` spawn. Checked AFTER the PR lease is acquired (the
/// mirror check in `merge` runs after ITS lease), so whichever action leases
/// second reliably sees the other's lease.
fn refuse_while_sibling_in_flight(id: &str) -> Result<(), String> {
    use super::merge::{commit_in_flight, lease_held, merge_in_flight};
    if lease_held(merge_in_flight(), id) {
        return Err(
            "a merge for this task is in progress — wait for it to finish before creating a PR"
                .to_string(),
        );
    }
    if lease_held(commit_in_flight(), id) {
        return Err(
            "a commit for this task is in progress — wait for it to finish before creating a PR"
                .to_string(),
        );
    }
    Ok(())
}

/// Push a task's worktree branch to `origin` and create a GitHub PR against
/// `base` (defaulting to the task's chosen base, else the project's current
/// branch). Requires the merge bar: worktree mode + committed + verified + a
/// passing readiness/structure-lock gauntlet. On success persists
/// `pr_url`/`pr_number` on the task and emits `nc:task`.
#[tauri::command]
pub async fn create_pr_task(
    app: AppHandle,
    id: String,
    base: Option<String>,
    title: String,
    body: String,
    draft: bool,
) -> Result<(), String> {
    // Gauntlets + push + `gh` are seconds of blocking work; run on the blocking
    // pool and await so the UI thread stays free (the WKWebView rule).
    tauri::async_runtime::spawn_blocking(move || {
        create_pr_task_blocking(&app, &id, base, &title, &body, draft)
    })
    .await
    .map_err(|e| format!("create PR failed to run: {e}"))?
}

/// The blocking body of `create_pr_task`, mirroring `merge_task_blocking`'s
/// order: lease → load → preconditions → gauntlets → resolve refs → push →
/// create → persist + emit.
fn create_pr_task_blocking(
    app: &AppHandle,
    id: &str,
    base: Option<String>,
    title: &str,
    body: &str,
    draft: bool,
) -> Result<(), String> {
    // Single-flight per task: refuse a second concurrent PR creation instead of
    // racing (held for the whole gauntlet→push→create body; released on every exit).
    let _lease = TaskLease::acquire(pr_in_flight(), id)
        .ok_or_else(|| "a PR creation for this task is already in progress".to_string())?;
    // Cross-action serialization: never push/create under an in-flight merge or
    // commit on the same task (see `refuse_while_sibling_in_flight`).
    refuse_while_sibling_in_flight(id)?;
    let store = app
        .try_state::<TaskStore>()
        .ok_or_else(|| "task store unavailable".to_string())?;
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    let project = require_project(app)?;
    let project_path = std::path::PathBuf::from(&project.path);

    // Preconditions: worktree mode (a main-mode task has no branch to push),
    // committed, verified — the same bar as merge.
    check_pr_preconditions(&task)?;

    // Unlike merge (which can integrate a branch after its worktree is gone), the
    // push + `gh` spawn both run IN the worktree dir, so it must exist.
    let worktree_dir = worktree::worktree_path(&project_path, id);
    if !worktree_dir.exists() {
        return Err(format!(
            "no worktree for task {id} — run it before creating a PR"
        ));
    }
    // The same gates merge_task_blocking runs (M4 §D + feature #3): a PR must not
    // be a side door around the readiness or structure-lock gauntlets. Reject on
    // failure — never force. Absent harness manifest ⇒ no lock checks ⇒ pass.
    let result = gauntlet::run(&worktree_dir);
    if !result.passed {
        let failed = result.failed_step.clone().unwrap_or_default();
        return Err(format!(
            "readiness gauntlet failed at `{failed}` — fix the checks before creating a PR"
        ));
    }
    let lock = gauntlet_project::run(&worktree_dir);
    if !lock.passed {
        let failed = lock.failed_check.clone().unwrap_or_default();
        return Err(format!(
            "structure-lock gauntlet failed at `{failed}` — fix the harness checks before creating a PR"
        ));
    }

    // The gauntlets run for SECONDS — wide enough for a parallel actor (a second
    // window, a completed merge, an earlier create) to change the task's publish
    // state. Re-read the task from the store and re-check the preconditions just
    // before anything leaves the machine, closing that window.
    let task = store
        .get(id)
        .ok_or_else(|| format!("no task with id {id}"))?;
    check_pr_preconditions(&task)?;

    // Branch + base honor the create dialog's picker, defaulting like merge does;
    // both are validated before they reach any argv (refs are git's injection
    // surface).
    let (branch, base) =
        resolve_branch_and_base(&task, id, base, || worktree::base_branch(&project_path))?;

    tracing::info!(target: "nightcore::pr", task_id = %id, branch = %branch, base = %base, draft, "pushing branch to origin for PR");
    // Plain push, never --force; `-u` sets the upstream so later pushes/status
    // reads resolve. Idempotent — a retry after a failed create just re-pushes.
    worktree::push_branch(&worktree_dir, &branch)?;

    let (url, number) = match create_or_recover_with(
        &worktree_dir,
        GH_BINARY,
        &branch,
        &base,
        title,
        body,
        draft,
    ) {
        PrCreateOutcome::Created { url, number } => (url, number),
        PrCreateOutcome::ToolAbsent => {
            return Err(
                "GitHub CLI (`gh`) is not installed — install it to create pull requests"
                    .to_string(),
            )
        }
        // gh's stderr is surfaced verbatim: it already explains itself (e.g.
        // "a pull request for branch … already exists" — though that exact shape
        // is normally recovered by the `gh pr view` net above).
        PrCreateOutcome::Failed { message } => return Err(message),
    };

    let updated = store.mutate(id, |t| {
        t.pr_url = Some(url.clone());
        t.pr_number = Some(number);
    })?;
    tracing::info!(target: "nightcore::pr", task_id = %id, pr_number = number, "created pull request");
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(())
}

/// The PR preconditions, pure so they are unit-testable without an `AppHandle`:
/// worktree run-mode (`refuse_main_mode_merge` twin — a main-mode task has no
/// branch to push), a commit on the branch, and an earned verified PASS (the
/// same bar as merge — a PR is a publish, not a side door around the gauntlet).
fn check_pr_preconditions(task: &Task) -> Result<(), String> {
    if !task.run_mode.is_worktree() {
        return Err(
            "this task runs on main — its changes are already on the project branch; \
             there is no worktree branch to open a PR from"
                .to_string(),
        );
    }
    if !task.committed {
        return Err(
            "task has no commit on its branch — commit it before creating a PR".to_string(),
        );
    }
    if !task.verified {
        return Err(
            "task is not verified — a reviewer must pass it (or accept the review) \
             before creating a PR"
                .to_string(),
        );
    }
    if task.merged {
        return Err("task is already merged — nothing to publish".to_string());
    }
    if task.pr_url.is_some() {
        return Err("a PR already exists for this task".to_string());
    }
    Ok(())
}

/// Resolve the branch/base pair for a PR, exactly like merge does (task branch →
/// `nc/<id>`; explicit base arg → task base → project current branch), then
/// validate BOTH through `validate_ref` before either reaches an argv. Pure.
fn resolve_branch_and_base(
    task: &Task,
    id: &str,
    base_arg: Option<String>,
    project_base: impl FnOnce() -> String,
) -> Result<(String, String), String> {
    let branch = task
        .branch
        .clone()
        .unwrap_or_else(|| worktree::branch_name(id));
    let base = base_arg
        .or_else(|| task.base_branch.clone())
        .unwrap_or_else(project_base);
    validate_ref(&branch)?;
    validate_ref(&base)?;
    Ok((branch, base))
}

/// The outcome of a `gh pr create` attempt. `ToolAbsent` is distinct from
/// `Failed` (the `secret_scan::ScanOutcome` precedent) so the caller can say
/// "install gh" rather than surface a spawn error.
enum PrCreateOutcome {
    /// The PR was created; the URL parsed from gh's stdout + the derived number.
    Created { url: String, number: u64 },
    /// The gh binary is not on PATH (the pre-spawn `which` probe — the ONLY
    /// ToolAbsent source; a spawn-time NotFound after a green probe is a
    /// vanished cwd and maps to `Failed`).
    ToolAbsent,
    /// gh exited non-zero (its stderr, verbatim) or its output was unusable.
    Failed { message: String },
}

/// The drained output of a bounded `gh` run (see [`run_gh_bounded`]). Shared
/// with the phase-2 status/finalize commands (`pr_status.rs`).
pub(super) struct GhOutput {
    pub(super) status: std::process::ExitStatus,
    pub(super) stdout: String,
    pub(super) stderr: String,
}

/// Spawn `binary args…` in `dir` (feeding `stdin_payload` when given), drain
/// both pipes on threads, and wait under `deadline` — `gh` talks to the
/// network, so a black-holed GitHub errors out (`timeout_msg`) instead of
/// pinning the blocking thread + PR lease forever. Errs are user-facing
/// strings; the caller decides the outcome mapping.
pub(super) fn run_gh_bounded(
    dir: &Path,
    binary: &str,
    args: &[&str],
    stdin_payload: Option<&str>,
    deadline: std::time::Duration,
    timeout_msg: &str,
) -> Result<GhOutput, String> {
    let mut child = match crate::platform::std_command(binary)
        .args(args)
        .current_dir(dir)
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        // The pre-spawn `which` probe is the ONLY ToolAbsent source: it already
        // resolved the binary, so a spawn-time NotFound here is almost always a
        // vanished cwd (the worktree was deleted under us — exactly what a racing
        // merge cleanup does), not a missing tool. Report it as a launch failure
        // naming the cwd instead of the misleading "gh is not installed".
        Err(e) => {
            return Err(format!(
                "could not launch `{binary}` in `{}` — the task's worktree may have been \
                 removed: {e}",
                dir.display()
            ))
        }
    };

    // Feed stdin from a detached thread so a large body can't deadlock against
    // a child that is also writing output (dropping the handle closes the pipe).
    if let (Some(payload), Some(mut stdin)) = (stdin_payload, child.stdin.take()) {
        let payload = payload.as_bytes().to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&payload);
        });
    }

    // Drain stdout AND stderr on threads so neither pipe can fill and block the
    // child; join after the bounded wait (the claude_oneshot discipline).
    fn drain<R: std::io::Read + Send + 'static>(
        pipe: Option<R>,
    ) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut buf = String::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_string(&mut buf);
            }
            buf
        })
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    let status = match crate::proc::wait_with_deadline(&mut child, deadline) {
        Ok(Some(status)) => status,
        Ok(None) => return Err(timeout_msg.to_string()),
        Err(e) => return Err(format!("`{binary}` did not finish: {e}")),
    };
    Ok(GhOutput {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// Create the PR via `gh pr create`, with the binary as a parameter — the
/// injection seam the tests use to exercise the real spawn path with a fake
/// script (the `secret_scan::scan_staged_with` template). The body travels on
/// **stdin** (`--body-file -`), never argv.
fn create_pr_with(
    dir: &Path,
    binary: &str,
    branch: &str,
    base: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> PrCreateOutcome {
    // Defence in depth: the caller already validated both refs, but this seam is
    // callable on its own, so re-check before splicing them into an argv.
    if let Err(e) = validate_ref(branch).and_then(|_| validate_ref(base)) {
        return PrCreateOutcome::Failed { message: e };
    }
    // Probe with `which` (PATHEXT-aware) instead of relying on a NotFound spawn
    // error — on Windows the platform resolver falls back to `cmd /C <name>`,
    // whose spawn SUCCEEDS then exits non-zero, which would misread "gh not
    // installed" as a create failure (the gitleaks-gate rationale).
    if which::which(binary).is_err() {
        return PrCreateOutcome::ToolAbsent;
    }

    let mut args = vec![
        "pr",
        "create",
        "--head",
        branch,
        "--base",
        base,
        "--title",
        title,
        "--body-file",
        "-",
    ];
    if draft {
        args.push("--draft");
    }
    let out = match run_gh_bounded(
        dir,
        binary,
        &args,
        Some(body),
        GH_TIMEOUT,
        "timed out creating the pull request on GitHub — check your network and try again",
    ) {
        Ok(out) => out,
        Err(message) => return PrCreateOutcome::Failed { message },
    };
    if !out.status.success() {
        let stderr = out.stderr.trim();
        let message = if stderr.is_empty() {
            format!("`{binary} pr create` failed (exit {:?})", out.status.code())
        } else {
            stderr.to_string()
        };
        return PrCreateOutcome::Failed { message };
    }
    match parse_pr_url(&out.stdout) {
        Some((url, number)) => PrCreateOutcome::Created { url, number },
        None => PrCreateOutcome::Failed {
            message: format!(
                "`{binary} pr create` succeeded but its output carried no PR URL — \
                 check the PR on GitHub; output was: {}",
                out.stdout.trim()
            ),
        },
    }
}

/// Create the PR, and on a create failure attempt RECOVERY through `gh pr view`:
/// if an OPEN PR for `branch` already exists, report it as `Created` instead of
/// surfacing the error. This is the idempotency net for two half-done shapes —
/// a create that succeeded on GitHub but died before Nightcore persisted the
/// URL, and a zero-exit create whose output carried no parseable URL — which
/// would otherwise fail every retry forever on "a pull request already exists".
/// `ToolAbsent` is never recovered (no gh ⇒ no view either).
fn create_or_recover_with(
    dir: &Path,
    binary: &str,
    branch: &str,
    base: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> PrCreateOutcome {
    match create_pr_with(dir, binary, branch, base, title, body, draft) {
        PrCreateOutcome::Failed { message } => match view_pr_with(dir, binary, branch) {
            Some((url, number)) => {
                tracing::info!(
                    target: "nightcore::pr",
                    branch = %branch,
                    pr_number = number,
                    "create failed but an open PR already exists for the branch — recovered"
                );
                PrCreateOutcome::Created { url, number }
            }
            None => PrCreateOutcome::Failed { message },
        },
        outcome => outcome,
    }
}

/// Look up the existing OPEN PR for `branch` via `gh pr view <branch> --json
/// url,number,state` in the worktree dir (the same bounded-spawn seam as
/// create). Best-effort by design: any failure — non-zero exit (no PR), a
/// timeout, unparseable JSON, a non-open PR — yields `None`, and the caller
/// surfaces the ORIGINAL create error instead.
fn view_pr_with(dir: &Path, binary: &str, branch: &str) -> Option<(String, u64)> {
    validate_ref(branch).ok()?;
    let out = run_gh_bounded(
        dir,
        binary,
        &["pr", "view", branch, "--json", "url,number,state"],
        None,
        GH_TIMEOUT,
        "timed out looking up the pull request on GitHub",
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_pr_view(&out.stdout)
}

/// Parse `gh pr view --json url,number,state` output into `(url, number)`,
/// accepting only an OPEN PR (a closed/merged PR for the branch must not be
/// resurrected as "the" created PR) with an https URL. Pure.
fn parse_pr_view(stdout: &str) -> Option<(String, u64)> {
    #[derive(serde::Deserialize)]
    struct View {
        url: String,
        number: u64,
        state: String,
    }
    let view: View = serde_json::from_str(stdout.trim()).ok()?;
    if view.state != "OPEN" || !view.url.starts_with("https://") {
        return None;
    }
    Some((view.url, view.number))
}

/// Parse the created PR's URL + number from `gh pr create` stdout. By contract
/// gh prints the URL as the trailing line (`https://…/pull/<n>`); scan from the
/// end for the first line that parses, tolerating trailing blank lines and any
/// leading chatter. Pure.
fn parse_pr_url(stdout: &str) -> Option<(String, u64)> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .find_map(|line| {
            if !line.starts_with("https://") {
                return None;
            }
            let number = pr_number_from_url(line)?;
            Some((line.to_string(), number))
        })
}

/// The PR number from a URL shaped `https://…/pull/<n>` (tolerating a trailing
/// slash). `None` when the shape doesn't match. Pure.
fn pr_number_from_url(url: &str) -> Option<u64> {
    let (_, tail) = url.rsplit_once("/pull/")?;
    tail.trim_end_matches('/').parse().ok()
}

/// Open `url` in the OS default browser — **https-only**. Every other scheme
/// (`http`, `file`, `javascript`, custom app schemes, …) is rejected, so a
/// stored task field or model output can never launch a local resource or
/// script through this seam. The URL is re-serialized from its parsed form
/// (normalized + percent-encoded) before it reaches the platform opener.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let normalized = validate_https_url(&url)?;
    open_in_browser(&normalized)
}

/// Parse + validate `url`: well-formed and scheme exactly `https`. Returns the
/// normalized serialization. Pure, unit-testable.
fn validate_https_url(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!(
            "refusing to open a non-https URL (scheme `{}`)",
            parsed.scheme()
        ));
    }
    Ok(parsed.to_string())
}

/// Hand a validated https URL to the platform's default-browser opener. The
/// child is reaped on a detached thread so no zombie lingers and the command
/// never blocks the caller.
#[cfg(target_os = "macos")]
fn open_in_browser(url: &str) -> Result<(), String> {
    spawn_and_reap(crate::platform::std_command("open").arg(url))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_browser(url: &str) -> Result<(), String> {
    spawn_and_reap(crate::platform::std_command("xdg-open").arg(url))
}

#[cfg(windows)]
fn open_in_browser(url: &str) -> Result<(), String> {
    // `start` is a cmd builtin (the first quoted token is the window title). The
    // whole tail is passed via `raw_arg` with the URL explicitly quoted so cmd's
    // metacharacters (& | ^ < >) inside it stay literal; a validated https URL
    // (re-serialized by the parser, which percent-encodes `"`) cannot break out
    // of the quoting.
    use std::os::windows::process::CommandExt;
    let mut cmd = crate::platform::std_command("cmd");
    cmd.raw_arg(format!("/C start \"\" \"{url}\""));
    spawn_and_reap(&mut cmd)
}

/// Spawn `cmd` and reap the child on a detached thread (the openers exit almost
/// immediately after handing the URL to the browser).
fn spawn_and_reap(cmd: &mut std::process::Command) -> Result<(), String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not open the browser: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::RunMode;
    use std::path::PathBuf;

    /// A task that clears every PR precondition (worktree + committed + verified).
    fn ready_task() -> Task {
        let mut task =
            Task::new("Add login".into(), "OAuth flow".into()).with_run_mode(RunMode::Worktree);
        task.committed = true;
        task.verified = true;
        task
    }

    #[test]
    fn preconditions_refuse_main_mode_uncommitted_and_unverified() {
        // Main mode: no branch to push (the refuse_main_mode_merge twin).
        let main_task = Task::new("edit on main".into(), String::new());
        let err = check_pr_preconditions(&main_task).expect_err("main mode is refused");
        assert!(err.contains("runs on main"), "explains the refusal: {err}");

        // Worktree but uncommitted: nothing on the branch to publish.
        let mut uncommitted =
            Task::new("wip".into(), String::new()).with_run_mode(RunMode::Worktree);
        uncommitted.verified = true;
        let err = check_pr_preconditions(&uncommitted).expect_err("uncommitted is refused");
        assert!(err.contains("commit"), "points at commit: {err}");

        // Worktree + committed but unverified: the same bar as merge.
        let mut unverified =
            Task::new("wip".into(), String::new()).with_run_mode(RunMode::Worktree);
        unverified.committed = true;
        let err = check_pr_preconditions(&unverified).expect_err("unverified is refused");
        assert!(err.contains("not verified"), "names the gate: {err}");

        // All three bars cleared ⇒ pass.
        assert!(check_pr_preconditions(&ready_task()).is_ok());
    }

    #[test]
    fn preconditions_refuse_merged_and_already_published_tasks() {
        // A merged task has nothing left to publish.
        let mut merged = ready_task();
        merged.merged = true;
        let err = check_pr_preconditions(&merged).expect_err("merged is refused");
        assert!(
            err.contains("already merged"),
            "explains the refusal: {err}"
        );

        // A task that already carries a PR must not create a second one.
        let mut published = ready_task();
        published.pr_url = Some("https://github.com/acme/widget/pull/7".into());
        let err = check_pr_preconditions(&published).expect_err("existing PR is refused");
        assert!(
            err.contains("already exists"),
            "explains the refusal: {err}"
        );
    }

    #[test]
    fn create_pr_refused_while_merge_or_commit_holds_the_task() {
        use super::super::merge::{commit_in_flight, merge_in_flight};
        // Merge direction: a live merge blocks PR creation (its cleanup would
        // delete the worktree/branch mid-push). Unique ids: the sets are global.
        let merge_lease =
            TaskLease::acquire(merge_in_flight(), "pr-vs-merge").expect("merge lease");
        let err = refuse_while_sibling_in_flight("pr-vs-merge").expect_err("create is refused");
        assert!(err.contains("merge"), "names the conflicting action: {err}");
        drop(merge_lease);
        assert!(refuse_while_sibling_in_flight("pr-vs-merge").is_ok());

        // Commit direction: a live commit blocks PR creation too (the push
        // would race the in-progress stage/commit of the same worktree).
        let commit_lease =
            TaskLease::acquire(commit_in_flight(), "pr-vs-commit").expect("commit lease");
        let err = refuse_while_sibling_in_flight("pr-vs-commit").expect_err("create is refused");
        assert!(
            err.contains("commit"),
            "names the conflicting action: {err}"
        );
        // Other tasks are unaffected, and dropping the lease frees this one.
        assert!(refuse_while_sibling_in_flight("pr-vs-commit-other").is_ok());
        drop(commit_lease);
        assert!(refuse_while_sibling_in_flight("pr-vs-commit").is_ok());
    }

    #[test]
    fn resolve_draft_base_prefers_explicit_then_task_then_project() {
        // No explicit base: the task's stored base wins, else the project's.
        let base = resolve_draft_base(None, Some("develop".into()), || "main".into());
        assert_eq!(base.as_deref(), Ok("develop"));
        let base = resolve_draft_base(None, None, || "main".into());
        assert_eq!(base.as_deref(), Ok("main"));

        // An explicit picker base beats both (the re-draft-on-base-change path).
        let base = resolve_draft_base(Some("release/2.0".into()), Some("develop".into()), || {
            "main".into()
        });
        assert_eq!(base.as_deref(), Ok("release/2.0"));

        // Blank/whitespace explicit base counts as "not provided".
        let base = resolve_draft_base(Some("   ".into()), Some("develop".into()), || "main".into());
        assert_eq!(base.as_deref(), Ok("develop"));

        // An option-injection base is rejected before it can reach git argv.
        let err = resolve_draft_base(Some("--force".into()), None, || "main".into())
            .expect_err("a dash base is rejected");
        assert!(err.contains("invalid branch/base name"), "err: {err}");
    }

    #[test]
    fn resolve_branch_and_base_defaults_then_validates() {
        // Defaults: nc/<id> + the project's current branch.
        let task = ready_task();
        let (branch, base) =
            resolve_branch_and_base(&task, "t-1", None, || "main".to_string()).expect("resolve");
        assert_eq!(branch, "nc/t-1");
        assert_eq!(base, "main");

        // The task's stored branch/base win over the defaults…
        let mut chosen = ready_task();
        chosen.branch = Some("feature/login".into());
        chosen.base_branch = Some("develop".into());
        let (branch, base) =
            resolve_branch_and_base(&chosen, "t-1", None, || "main".to_string()).expect("resolve");
        assert_eq!(branch, "feature/login");
        assert_eq!(base, "develop");

        // …and an explicit base argument beats the task's stored base.
        let (_, base) = resolve_branch_and_base(&chosen, "t-1", Some("release/2.0".into()), || {
            "main".to_string()
        })
        .expect("resolve");
        assert_eq!(base, "release/2.0");

        // Option-injection refs are rejected on BOTH axes (validate_ref).
        let mut hostile = ready_task();
        hostile.branch = Some("-D".into());
        assert!(
            resolve_branch_and_base(&hostile, "t-1", None, || "main".to_string()).is_err(),
            "a dash branch is rejected"
        );
        let err = resolve_branch_and_base(&ready_task(), "t-1", Some("--force".into()), || {
            "main".to_string()
        })
        .expect_err("a dash base is rejected");
        assert!(err.contains("invalid branch/base name"), "err: {err}");
    }

    #[test]
    fn parse_pr_url_reads_the_trailing_line() {
        // The clean contract shape: the URL is the last line.
        assert_eq!(
            parse_pr_url("https://github.com/acme/widget/pull/123\n"),
            Some(("https://github.com/acme/widget/pull/123".to_string(), 123))
        );
        // gh may print chatter first (e.g. "Creating pull request for … into …").
        let noisy = "Creating pull request for nc/t-1 into main in acme/widget\n\n\
                     https://github.com/acme/widget/pull/7\n\n";
        assert_eq!(
            parse_pr_url(noisy),
            Some(("https://github.com/acme/widget/pull/7".to_string(), 7))
        );
        // A trailing slash still parses; GHES-style hosts too.
        assert_eq!(
            parse_pr_url("https://git.corp.example/o/r/pull/42/"),
            Some(("https://git.corp.example/o/r/pull/42/".to_string(), 42))
        );
        // No URL, a non-https line, or an unparseable number ⇒ None.
        assert_eq!(parse_pr_url("nothing here"), None);
        assert_eq!(parse_pr_url("http://github.com/acme/widget/pull/1"), None);
        assert_eq!(
            parse_pr_url("https://github.com/acme/widget/pull/abc"),
            None
        );
        assert_eq!(parse_pr_url(""), None);
    }

    #[test]
    fn pr_number_from_url_parses_the_tail() {
        assert_eq!(pr_number_from_url("https://github.com/a/b/pull/9"), Some(9));
        assert_eq!(
            pr_number_from_url("https://github.com/a/b/pull/9/"),
            Some(9)
        );
        assert_eq!(pr_number_from_url("https://github.com/a/b/issues/9"), None);
        assert_eq!(pr_number_from_url("https://github.com/a/b/pull/"), None);
    }

    /// Write an executable shell script into `dir` to stand in for `gh`, so the
    /// tests exercise the real spawn + stdin + exit-code mapping (not a mock) —
    /// the `secret_scan` fixture pattern.
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

    #[test]
    #[cfg(unix)]
    fn create_pr_with_success_parses_url_and_feeds_body_on_stdin() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        // The fake gh records its argv and its stdin, then prints the URL line.
        let script = fake_gh(
            tmp.path(),
            "printf '%s\\n' \"$@\" > args.txt\ncat > body.txt\n\
             echo 'Creating pull request for nc/t-1 into main'\n\
             echo 'https://github.com/acme/widget/pull/42'",
        );
        let outcome = create_pr_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            "nc/t-1",
            "main",
            "feat: add login",
            "## Summary\nbody text",
            true,
        );
        let PrCreateOutcome::Created { url, number } = outcome else {
            panic!("expected Created");
        };
        assert_eq!(url, "https://github.com/acme/widget/pull/42");
        assert_eq!(number, 42);

        // The body arrived on stdin, never argv.
        let body = std::fs::read_to_string(tmp.path().join("body.txt")).expect("body.txt");
        assert_eq!(body, "## Summary\nbody text");
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args.txt");
        let args: Vec<&str> = args.lines().collect();
        assert!(
            !args.iter().any(|a| a.contains("Summary")),
            "the body must not appear in argv: {args:?}"
        );
        // The argv carries the contract flags: head/base/title, body from stdin,
        // and --draft when requested.
        for expected in [
            "pr",
            "create",
            "--head",
            "nc/t-1",
            "--base",
            "main",
            "--title",
            "feat: add login",
            "--body-file",
            "-",
            "--draft",
        ] {
            assert!(
                args.contains(&expected),
                "argv missing {expected}: {args:?}"
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn create_pr_with_omits_draft_flag_when_not_draft() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "printf '%s\\n' \"$@\" > args.txt\ncat > /dev/null\n\
             echo 'https://github.com/acme/widget/pull/1'",
        );
        let outcome = create_pr_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            "nc/t-1",
            "main",
            "t",
            "b",
            false,
        );
        assert!(matches!(outcome, PrCreateOutcome::Created { .. }));
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args.txt");
        assert!(
            !args.lines().any(|a| a == "--draft"),
            "no --draft when draft=false: {args}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn create_pr_with_surfaces_stderr_verbatim_on_failure() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "cat > /dev/null\n\
             echo 'a pull request for branch \"nc/t-1\" into branch \"main\" already exists' >&2\n\
             exit 1",
        );
        let outcome = create_pr_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            "nc/t-1",
            "main",
            "t",
            "b",
            false,
        );
        let PrCreateOutcome::Failed { message } = outcome else {
            panic!("a non-zero exit must map to Failed");
        };
        assert!(
            message.contains("already exists"),
            "gh's stderr is verbatim: {message}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn create_pr_with_zero_exit_but_no_url_is_a_loud_failure() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(tmp.path(), "cat > /dev/null\necho 'no url here'");
        let outcome = create_pr_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            "nc/t-1",
            "main",
            "t",
            "b",
            false,
        );
        let PrCreateOutcome::Failed { message } = outcome else {
            panic!("a URL-less success must map to Failed");
        };
        assert!(message.contains("no PR URL"), "{message}");
    }

    #[test]
    #[cfg(unix)]
    fn create_pr_with_vanished_cwd_is_a_launch_failure_not_tool_absent() {
        // The binary EXISTS (which succeeds) but the worktree dir is gone by
        // spawn time — the racing-merge-cleanup shape. That spawn NotFound must
        // NOT read as "gh is not installed"; it is a launch failure naming the
        // cwd so the user looks at the worktree, not their gh install.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(tmp.path(), "echo 'https://github.com/acme/widget/pull/1'");
        let gone = tmp.path().join("deleted-worktree");
        let outcome = create_pr_with(
            &gone,
            script.to_str().expect("utf8 path"),
            "nc/t-1",
            "main",
            "t",
            "b",
            false,
        );
        let PrCreateOutcome::Failed { message } = outcome else {
            panic!("a vanished cwd must map to Failed, not ToolAbsent");
        };
        assert!(
            message.contains("deleted-worktree"),
            "the failure names the cwd: {message}"
        );
        assert!(
            message.contains("worktree may have been removed"),
            "the failure explains the likely cause: {message}"
        );
    }

    #[test]
    fn create_pr_with_absent_binary_is_tool_absent_not_failed() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let outcome = create_pr_with(
            tmp.path(),
            "definitely-not-a-real-binary-xyz",
            "nc/t-1",
            "main",
            "t",
            "b",
            false,
        );
        assert!(
            matches!(outcome, PrCreateOutcome::ToolAbsent),
            "a missing gh is ToolAbsent (install-to-arm, the gitleaks contract)"
        );
    }

    #[test]
    fn create_pr_with_rejects_injection_refs_before_any_spawn() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        // The binary doesn't exist — but validation runs FIRST, so the outcome is
        // the validation Failure, not ToolAbsent: proof no probe/spawn happened.
        for (branch, base) in [("-D", "main"), ("nc/t-1", "--force")] {
            let outcome = create_pr_with(
                tmp.path(),
                "definitely-not-a-real-binary-xyz",
                branch,
                base,
                "t",
                "b",
                false,
            );
            let PrCreateOutcome::Failed { message } = outcome else {
                panic!("a dash ref must be rejected before the tool probe");
            };
            assert!(
                message.contains("invalid branch/base name"),
                "validate_ref rejection reaches create: {message}"
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn create_or_recover_recovers_an_existing_open_pr_when_create_fails() {
        // The half-done shape: a previous create landed the PR on GitHub but
        // the app died before persisting, so every retry's `pr create` fails
        // with "already exists". Recovery resolves it via `pr view` and maps
        // the retry to Created instead of failing forever.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            r#"if [ "$2" = "create" ]; then
  cat > /dev/null
  echo 'a pull request for branch "nc/t-1" into branch "main" already exists' >&2
  exit 1
fi
if [ "$2" = "view" ]; then
  printf '%s\n' "$@" > view-args.txt
  echo '{"url":"https://github.com/acme/widget/pull/9","number":9,"state":"OPEN"}'
  exit 0
fi
exit 1"#,
        );
        let outcome = create_or_recover_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            "nc/t-1",
            "main",
            "t",
            "b",
            false,
        );
        let PrCreateOutcome::Created { url, number } = outcome else {
            panic!("a failed create with an existing open PR must recover to Created");
        };
        assert_eq!(url, "https://github.com/acme/widget/pull/9");
        assert_eq!(number, 9);
        // The recovery asked `pr view` for the branch's url/number/state.
        let args = std::fs::read_to_string(tmp.path().join("view-args.txt")).expect("args");
        assert!(args.contains("view"), "recovery path used pr view: {args}");
        assert!(args.contains("nc/t-1"), "view targets the branch: {args}");
    }

    #[test]
    #[cfg(unix)]
    fn create_or_recover_surfaces_the_original_error_when_no_pr_exists() {
        // A genuine create failure (nothing on GitHub) must keep the create's
        // own stderr, not a recovery artifact.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            r#"if [ "$2" = "create" ]; then
  cat > /dev/null
  echo 'gh: authentication required' >&2
  exit 1
fi
echo 'no pull requests found' >&2
exit 1"#,
        );
        let outcome = create_or_recover_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            "nc/t-1",
            "main",
            "t",
            "b",
            false,
        );
        let PrCreateOutcome::Failed { message } = outcome else {
            panic!("no recoverable PR ⇒ the original failure surfaces");
        };
        assert_eq!(
            message, "gh: authentication required",
            "the CREATE error is kept, not the view's"
        );
    }

    #[test]
    #[cfg(unix)]
    fn create_or_recover_recovers_the_zero_exit_no_url_branch_too() {
        // gh exits 0 but prints no URL (the unusable-output branch): recovery
        // still resolves the PR via view, so the user is not stranded.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            r#"if [ "$2" = "create" ]; then
  cat > /dev/null
  echo 'no url in this output'
  exit 0
fi
if [ "$2" = "view" ]; then
  echo '{"url":"https://github.com/acme/widget/pull/12","number":12,"state":"OPEN"}'
  exit 0
fi
exit 1"#,
        );
        let outcome = create_or_recover_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            "nc/t-1",
            "main",
            "t",
            "b",
            false,
        );
        assert!(
            matches!(outcome, PrCreateOutcome::Created { number: 12, .. }),
            "the zero-exit-no-URL create recovers through pr view"
        );
    }

    #[test]
    fn parse_pr_view_accepts_only_open_https_prs() {
        assert_eq!(
            parse_pr_view(r#"{"url":"https://github.com/a/b/pull/7","number":7,"state":"OPEN"}"#),
            Some(("https://github.com/a/b/pull/7".to_string(), 7))
        );
        // A closed/merged PR must not be resurrected as "the" created PR.
        for state in ["CLOSED", "MERGED"] {
            assert_eq!(
                parse_pr_view(&format!(
                    r#"{{"url":"https://github.com/a/b/pull/7","number":7,"state":"{state}"}}"#
                )),
                None,
                "{state} is not recoverable"
            );
        }
        // Non-https URLs and garbage are rejected.
        assert_eq!(
            parse_pr_view(r#"{"url":"http://github.com/a/b/pull/7","number":7,"state":"OPEN"}"#),
            None
        );
        assert_eq!(parse_pr_view("not json"), None);
        assert_eq!(parse_pr_view(""), None);
    }

    #[test]
    fn open_external_accepts_only_https() {
        assert_eq!(
            validate_https_url("https://github.com/acme/widget/pull/7").as_deref(),
            Ok("https://github.com/acme/widget/pull/7")
        );
        for bad in [
            "http://github.com/acme/widget/pull/7", // downgrade
            "file:///etc/passwd",                   // local resource
            "javascript:alert(1)",                  // script
            "nightcore://internal",                 // custom scheme
            "ftp://host/file",                      // legacy scheme
            "github.com/acme/widget",               // no scheme
            "not a url at all",
            "",
        ] {
            assert!(
                validate_https_url(bad).is_err(),
                "must reject {bad:?} (https-only)"
            );
        }
    }
}
