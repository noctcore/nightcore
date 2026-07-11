//! The create-PR command and its orchestration: the per-task single-flight
//! guard, the merge-bar preconditions + gauntlets, ref resolution, the push,
//! and the `gh pr create` seam (with the `gh pr view` idempotency recovery).

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

use super::parse::{parse_pr_url, parse_pr_view};
use crate::gauntlet;
use crate::gauntlet_project;
use crate::git::gh::{map_gh_failure, run_gh_bounded, GH_BINARY};
use crate::git::validate_ref;
use crate::store::types::StructureLockResult;
use crate::store::TaskStore;
use crate::task::{Task, TASK_EVENT};
use crate::workflow::merge::{require_project, TaskLease};
use crate::worktree;

/// Wall-clock bound on every network-facing `gh` spawn (create + view). Same
/// rationale as the push deadline: generous, but finite — a black-holed GitHub
/// must error out, not pin the blocking thread + PR lease with the dialog stuck
/// on "Creating…".
const GH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Per-task single-flight guard for PR creation (the pattern of
/// `commit_in_flight`/`merge_in_flight` in [`crate::workflow::merge`]): a double-fired
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
    use crate::workflow::merge::{commit_in_flight, lease_held, merge_in_flight};
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
    // A fresh worktree checks out NO `node_modules` (gitignored), and non-hoisted,
    // package-local deps in the main checkout are invisible to it, so `tsc -b` fails
    // with "Cannot find module …" (exit 2) until the worktree is installed from its
    // committed lockfile. Provision deterministically BEFORE the gauntlet so the
    // checks run against a real, resolvable environment (a no-op for non-JS projects).
    worktree::provision_deps(&worktree_dir)?;
    // The same gates merge_task_blocking runs (M4 §D + feature #3): a PR must not
    // be a side door around the readiness or structure-lock gauntlets. Reject on
    // failure — never force. Absent harness manifest ⇒ no lock checks ⇒ pass.
    let result = gauntlet::run(&worktree_dir);
    if !result.passed {
        return Err(readiness_failure_message(&result));
    }
    let lock = gauntlet_project::run(&worktree_dir);
    if !lock.passed {
        return Err(structure_lock_failure_message(&lock));
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

    // GitHub two-way sync (#97, §3.5): defensively guarantee an issue-linked task's
    // PR carries `Closes #N` so a merge auto-closes the issue natively (Nightcore
    // never issues an explicit close). Idempotent — the dialog already pre-filled it
    // (draft path), so this only re-adds it if the user edited the keyword out, and
    // never duplicates one that is present. `Closes #N` needs no issue-write scope
    // (it rides the PR body the user already has push rights to), so it is unaffected
    // by the sync-enabled toggle or the degradation ladder.
    let body = match task.issue_number {
        Some(n) => ensure_closes_keyword(body, n),
        None => body.to_string(),
    };

    let (url, number) = match create_or_recover_with(
        &worktree_dir,
        GH_BINARY,
        &branch,
        &base,
        title,
        &body,
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

    let updated = persist_created_pr(&store, id, &url, number, &base)?;
    tracing::info!(target: "nightcore::pr", task_id = %id, pr_number = number, "created pull request");
    let _ = app.emit(TASK_EVENT, &updated);
    Ok(())
}

/// Persist a created PR on the task: `pr_url`/`pr_number` plus the RESOLVED
/// base it was opened against. Grounding `base_branch` here is what keeps the
/// whole later chain honest — the pull-base fast-forward and the confirm-dialog
/// copy both key on `task.base_branch`, so a task created against the project's
/// then-current branch must remember it instead of leaving `None` (which used
/// to make the pull re-guess from whatever branch the root happens to be on).
/// Store-only (no `AppHandle`), so the persistence is unit-testable.
fn persist_created_pr(
    store: &TaskStore,
    id: &str,
    url: &str,
    number: u64,
    base: &str,
) -> Result<Task, String> {
    store.mutate(id, |t| {
        t.pr_url = Some(url.to_string());
        t.pr_number = Some(number);
        t.base_branch = Some(base.to_string());
    })
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

/// Append the failing gauntlet step's exact command, exit code, and a tail of its
/// output to a failure header, so the create-PR dialog explains *why* the gate
/// failed — not just which step (feature #3). Empty when no detail is available
/// (e.g. a step that never captured output). Pure + reused by both gauntlet gates.
fn step_failure_detail(command: &str, exit_code: Option<i32>, output: Option<&str>) -> String {
    let mut detail = format!("\n\n$ {command}");
    if let Some(code) = exit_code {
        detail.push_str(&format!("  (exit {code})"));
    }
    if let Some(out) = output {
        let out = out.trim();
        if !out.is_empty() {
            detail.push('\n');
            detail.push_str(out);
        }
    }
    detail
}

/// The create-PR error for a failed READINESS gauntlet: name the failing step and
/// fold in its command + exit code + output tail (feature #3). Pure so the payload
/// shape is unit-testable without a real worktree.
fn readiness_failure_message(result: &gauntlet::GauntletResult) -> String {
    let failed = result.failed_step.as_deref().unwrap_or("unknown");
    let detail = result
        .steps
        .iter()
        .find(|s| s.name == failed)
        .map(|s| step_failure_detail(&s.command, s.exit_code, s.output.as_deref()))
        .unwrap_or_default();
    format!("readiness gauntlet failed at `{failed}` — fix the checks before creating a PR{detail}")
}

/// The create-PR error for a failed STRUCTURE-LOCK gauntlet: the harness twin of
/// [`readiness_failure_message`], folding in the failing check's command + exit
/// code + output tail. Pure + unit-testable.
fn structure_lock_failure_message(lock: &StructureLockResult) -> String {
    let failed = lock.failed_check.as_deref().unwrap_or("unknown");
    let detail = lock
        .checks
        .iter()
        .find(|c| c.name == failed)
        .map(|c| step_failure_detail(&c.command, c.exit_code, c.output.as_deref()))
        .unwrap_or_default();
    format!(
        "structure-lock gauntlet failed at `{failed}` — fix the harness checks before creating a PR{detail}"
    )
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

/// GitHub two-way sync (#97, §3.5): the closing keywords GitHub recognizes in a PR
/// body to auto-close a referenced issue on merge. Detection is case-insensitive, so
/// these are matched lowercased.
const CLOSING_KEYWORDS: [&str; 9] = [
    "close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved",
];

/// Append `Closes #N` to a PR body unless it already references closing issue `n`
/// via any GitHub keyword (`close(s|d)` / `fix(es|ed)` / `resolve(s|d)` + `#n`,
/// case-insensitive). Pure + idempotent (§3.5): an issue-linked task's PR gets the
/// keyword that auto-closes the issue on merge, without duplicating one the dialog
/// pre-fill or the user already typed. Reused by the create path (defensive) and the
/// draft path (the visible pre-fill).
pub(crate) fn ensure_closes_keyword(body: &str, n: u64) -> String {
    if body_closes_issue(body, n) {
        return body.to_string();
    }
    let trimmed = body.trim_end();
    if trimmed.is_empty() {
        return format!("Closes #{n}");
    }
    format!("{trimmed}\n\nCloses #{n}")
}

/// Whether `body` already closes issue `n` — a closing keyword immediately before a
/// `#n` reference (case-insensitive). Guards against a partial numeric match (`#12`
/// inside `#123`) and requires the keyword to be a whole word, so a bare `#12` or an
/// unrelated word ending in a keyword (`prefixes #12`) does not count as closing.
fn body_closes_issue(body: &str, n: u64) -> bool {
    let lower = body.to_lowercase();
    let token = format!("#{n}");
    let mut from = 0;
    while let Some(rel) = lower[from..].find(&token) {
        let at = from + rel;
        let after = at + token.len();
        // Reject `#12` when the real reference is `#123` (a longer number).
        let next_is_digit = lower[after..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit());
        if !next_is_digit && preceding_keyword(&lower[..at]) {
            return true;
        }
        from = after;
    }
    false
}

/// Whether the text immediately before a `#n` reference ends in a closing keyword
/// (a whole word). The keyword may be followed by spaces and an optional colon
/// (`Closes: #12`) before the reference — the shape GitHub accepts.
fn preceding_keyword(before: &str) -> bool {
    let head = before.trim_end_matches([' ', '\t', ':']);
    CLOSING_KEYWORDS.iter().any(|kw| {
        head.len() >= kw.len() && head.ends_with(kw) && {
            let start = head.len() - kw.len();
            // Whole-word: the char before the keyword must be a boundary, so
            // `prefixes` does not match `fixes`.
            start == 0 || !head.as_bytes()[start - 1].is_ascii_alphanumeric()
        }
    })
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
        return PrCreateOutcome::Failed {
            message: map_gh_failure(binary, "pr create", &out),
        };
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gauntlet::{GauntletResult, GauntletStep};
    use crate::store::types::{StepStatus, StructureLockCheck};
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
    fn readiness_failure_message_carries_the_failing_step_command_and_output() {
        // The empirical PR-blocker: a `typecheck` that exits 2. The dialog must
        // show the command + exit code + output tail (feature #3), not just the name.
        let result = GauntletResult {
            passed: false,
            failed_step: Some("typecheck".to_string()),
            steps: vec![
                GauntletStep {
                    name: "typecheck".to_string(),
                    command: "bun run typecheck".to_string(),
                    status: StepStatus::Failed,
                    exit_code: Some(2),
                    output: Some(
                        "src/x.ts(5,8): error TS2307: Cannot find module 'zod'".to_string(),
                    ),
                },
                GauntletStep {
                    name: "lint".to_string(),
                    command: "bun run lint".to_string(),
                    status: StepStatus::Skipped,
                    exit_code: None,
                    output: None,
                },
            ],
        };
        let msg = readiness_failure_message(&result);
        assert!(
            msg.contains("readiness gauntlet failed at `typecheck`"),
            "names the step: {msg}"
        );
        assert!(
            msg.contains("bun run typecheck"),
            "carries the command: {msg}"
        );
        assert!(msg.contains("exit 2"), "carries the exit code: {msg}");
        assert!(
            msg.contains("Cannot find module 'zod'"),
            "carries the output tail: {msg}"
        );
    }

    #[test]
    fn structure_lock_failure_message_carries_the_failing_check_command_and_output() {
        let lock = StructureLockResult {
            passed: false,
            failed_check: Some("folder-per-component".to_string()),
            checks: vec![StructureLockCheck {
                name: "folder-per-component".to_string(),
                kind: "lint-plugin".to_string(),
                command: "bun run lint:harness".to_string(),
                status: StepStatus::Failed,
                exit_code: Some(1),
                output: Some("Component must live in its own folder".to_string()),
            }],
        };
        let msg = structure_lock_failure_message(&lock);
        assert!(
            msg.contains("structure-lock gauntlet failed at `folder-per-component`"),
            "names the check: {msg}"
        );
        assert!(
            msg.contains("bun run lint:harness"),
            "carries the command: {msg}"
        );
        assert!(msg.contains("exit 1"), "carries the exit code: {msg}");
        assert!(
            msg.contains("must live in its own folder"),
            "carries the output tail: {msg}"
        );
    }

    #[test]
    fn failure_message_falls_back_to_the_header_when_no_step_detail_is_present() {
        // An empty steps list (or a `failed_step` absent from `steps`) still yields
        // the human header — never a panic or an empty string.
        let result = GauntletResult {
            passed: false,
            steps: Vec::new(),
            failed_step: None,
        };
        let msg = readiness_failure_message(&result);
        assert!(
            msg.contains("readiness gauntlet failed at `unknown`"),
            "graceful header: {msg}"
        );
        assert!(
            !msg.contains("$ "),
            "no command block when there is no detail: {msg}"
        );
    }

    #[test]
    fn create_pr_refused_while_merge_or_commit_holds_the_task() {
        use crate::workflow::merge::{commit_in_flight, merge_in_flight};
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
    fn ensure_closes_keyword_appends_when_absent() {
        // A plain body gains a `Closes #N` line separated by a blank line.
        let out = ensure_closes_keyword("## Summary\n- did work", 42);
        assert_eq!(out, "## Summary\n- did work\n\nCloses #42");

        // An empty body becomes just the keyword (no leading blank lines).
        assert_eq!(ensure_closes_keyword("", 7), "Closes #7");
        assert_eq!(ensure_closes_keyword("   \n\n", 7), "Closes #7");

        // Trailing whitespace is trimmed before the keyword is appended.
        assert_eq!(ensure_closes_keyword("body\n\n", 3), "body\n\nCloses #3");
    }

    #[test]
    fn ensure_closes_keyword_is_idempotent_across_keywords_and_case() {
        // Every recognized keyword + case variant already-present ⇒ no-op.
        for present in [
            "Closes #12",
            "closes #12",
            "CLOSES #12",
            "Fixes #12",
            "fixed #12",
            "Resolves #12",
            "resolve #12",
            "Closed #12",
            "Closes: #12",
            "This PR closes #12 and adds tests",
        ] {
            assert_eq!(
                ensure_closes_keyword(present, 12),
                present,
                "already-closing body is untouched: {present:?}"
            );
        }
    }

    #[test]
    fn ensure_closes_keyword_guards_partial_numbers_and_bare_refs() {
        // `#12` inside `#123` is NOT a close of issue 12 — the keyword still appends.
        let out = ensure_closes_keyword("Closes #123", 12);
        assert_eq!(out, "Closes #123\n\nCloses #12");

        // A bare `#12` with no closing keyword before it does not count.
        let out = ensure_closes_keyword("see #12 for context", 12);
        assert_eq!(out, "see #12 for context\n\nCloses #12");

        // A word that merely ENDS in a keyword (`prefixes`) is not a whole-word match.
        let out = ensure_closes_keyword("prefixes #12", 12);
        assert_eq!(out, "prefixes #12\n\nCloses #12");
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
    fn persist_created_pr_grounds_url_number_and_base() {
        let tmp = tempfile::TempDir::new().expect("store dir");
        let store = TaskStore::load_from(tmp.path().join("tasks"));
        let task = ready_task();
        let id = task.id.clone();
        store.upsert(&task).expect("seed");

        let updated =
            persist_created_pr(&store, &id, "https://github.com/a/b/pull/7", 7, "develop")
                .expect("persist");
        assert_eq!(
            updated.pr_url.as_deref(),
            Some("https://github.com/a/b/pull/7")
        );
        assert_eq!(updated.pr_number, Some(7));
        assert_eq!(
            updated.base_branch.as_deref(),
            Some("develop"),
            "the RESOLVED base is grounded on the task at creation"
        );
        // Persisted via the store, not just returned.
        let stored = store.get(&id).expect("task");
        assert_eq!(stored.base_branch.as_deref(), Some("develop"));
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
}
