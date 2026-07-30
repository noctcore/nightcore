//! Worktree lifecycle: allocate, remove, and startup reconciliation.
//!
//! The security-sensitive half of the module — every dir it creates or deletes is
//! confined to the `<project>/.nightcore/worktrees/<taskId>` base via
//! [`super::path::worktrees_base`] / [`super::path::is_under`], so the user's main
//! checkout can never be touched. Every git call routes through the module's single
//! [`super::git`] spawner.

use std::path::{Path, PathBuf};

use super::git;
use super::path::{
    branch_name, is_clean_slug, is_under, terminal_branch_name, terminal_worktree_path,
    terminal_worktrees_base, worktree_path, worktrees_base,
};
use crate::git::validate_ref;

/// Create a worktree + branch for `task_id` off the current `HEAD`. Idempotent in
/// the sense that an existing worktree dir is reused (returns its path) rather than
/// erroring, so a re-run after a crash doesn't fail to allocate.
pub fn allocate(project_path: &Path, task_id: &str) -> Result<PathBuf, String> {
    let dir = worktree_path(project_path, task_id);
    if dir.exists() {
        return Ok(dir); // already allocated (crash recovery / re-run)
    }
    std::fs::create_dir_all(worktrees_base(project_path))
        .map_err(|e| format!("failed to create worktrees base: {e}"))?;

    let branch = branch_name(task_id);
    let dir_str = dir.to_string_lossy().to_string();

    // If the branch already exists (a prior run we kept for inspection), check it
    // out into a fresh worktree instead of creating it.
    let branch_exists = git(
        project_path,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &branch,
        ],
    )
    .is_ok();

    let args: Vec<&str> = if branch_exists {
        vec!["worktree", "add", &dir_str, "--end-of-options", &branch]
    } else {
        // `-b <branch>` consumes `branch` as the flag's argument (never as an option).
        vec!["worktree", "add", &dir_str, "-b", &branch]
    };
    // Concurrency #3: two worktree-mode launches racing the auto-loop both pass the
    // `is_worktree_clean` check, then both run `git worktree add`. They target
    // DISJOINT dirs (`<base>/<task_id>`), so they never clobber, but git serializes
    // worktree admin behind a `.git/worktrees` lock and the loser fails transiently
    // ("File exists"/"is already locked"). Treat that as retryable with a short
    // backoff so a concurrent allocate isn't a spurious launch failure.
    git_worktree_add_retrying(project_path, &args)?;
    Ok(dir)
}

/// Create a worktree for `task_id` checked out on `branch`, branching off `base`
/// when `branch` doesn't exist yet (else the existing branch is resumed and `base`
/// is ignored). The branch/base-aware variant of [`allocate`], used when the create
/// dialog's branch picker supplied a custom branch and/or base. Idempotent: an
/// existing worktree dir is reused.
pub fn allocate_branch(
    project_path: &Path,
    task_id: &str,
    branch: &str,
    base: &str,
) -> Result<PathBuf, String> {
    let dir = worktree_path(project_path, task_id);
    if dir.exists() {
        return Ok(dir); // already allocated (crash recovery / re-run)
    }
    std::fs::create_dir_all(worktrees_base(project_path))
        .map_err(|e| format!("failed to create worktrees base: {e}"))?;
    let dir_str = dir.to_string_lossy().to_string();
    // Reject a picker-supplied branch git would read as an OPTION (leading `-`) or
    // that is not a legal ref, before it reaches any `git` argument list.
    validate_ref(branch)?;
    let branch_exists = git(
        project_path,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            branch,
        ],
    )
    .is_ok();
    let args: Vec<&str> = if branch_exists {
        // Resume an existing branch in a fresh worktree (base is irrelevant).
        vec!["worktree", "add", &dir_str, "--end-of-options", branch]
    } else {
        // Create `branch` off `base`. `-b <branch>` consumes `branch` as the flag's
        // argument; `--end-of-options` guards the trailing `base` positional.
        validate_ref(base)?;
        vec![
            "worktree",
            "add",
            &dir_str,
            "-b",
            branch,
            "--end-of-options",
            base,
        ]
    };
    git_worktree_add_retrying(project_path, &args)?;
    Ok(dir)
}

/// Create a user-driven *terminal* worktree under the separate `term/` namespace
/// (spec PR 5) — NOT a task worktree. Places the dir at
/// `<project>/.nightcore/worktrees-term/<slug>` and, when `create_branch`, checks out a
/// new `term/<slug>` branch off `base` (resuming it if it already exists); otherwise it
/// checks out `base` on a DETACHED HEAD (a scratch worktree at base with no new branch).
/// Because it lives outside [`worktrees_base`], the startup [`reconcile`] sweep — which
/// keys on live task ids — never garbage-collects it. Idempotent: an existing dir for the
/// slug is reused. The `slug` MUST already be a clean slug ([`is_clean_slug`]); the
/// command layer derives it via [`super::path::slugify`].
pub fn allocate_terminal(
    project_path: &Path,
    slug: &str,
    create_branch: bool,
    base: &str,
) -> Result<PathBuf, String> {
    if !is_clean_slug(slug) {
        return Err(format!("invalid terminal worktree name {slug:?}"));
    }
    let dir = terminal_worktree_path(project_path, slug);
    if dir.exists() {
        return Ok(dir); // already allocated (re-create is idempotent)
    }
    std::fs::create_dir_all(terminal_worktrees_base(project_path))
        .map_err(|e| format!("failed to create terminal worktrees base: {e}"))?;
    let dir_str = dir.to_string_lossy().to_string();
    // `base` is spliced into `git worktree add` as a positional — reject an
    // option-shaped/illegal ref before it reaches argv (mirrors `allocate_branch`).
    validate_ref(base)?;
    let branch = terminal_branch_name(slug);
    let args: Vec<&str> = if create_branch {
        validate_ref(&branch)?;
        let branch_exists = git(
            project_path,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "--end-of-options",
                &branch,
            ],
        )
        .is_ok();
        if branch_exists {
            // Resume an existing `term/<slug>` branch in a fresh worktree (base ignored).
            vec!["worktree", "add", &dir_str, "--end-of-options", &branch]
        } else {
            // Create `term/<slug>` off `base`. `-b <branch>` consumes the branch as the
            // flag's argument; `--end-of-options` guards the trailing `base` positional.
            vec![
                "worktree",
                "add",
                &dir_str,
                "-b",
                &branch,
                "--end-of-options",
                base,
            ]
        }
    } else {
        // No new branch: a scratch worktree at `base` on a detached HEAD.
        vec![
            "worktree",
            "add",
            &dir_str,
            "--detach",
            "--end-of-options",
            base,
        ]
    };
    git_worktree_add_retrying(project_path, &args)?;
    Ok(dir)
}

/// Run `git worktree add` with a small bounded retry on git's transient
/// worktree-lock contention (concurrency #3). A non-lock error fails immediately
/// (only lock contention is retried); the dir is disjoint per task, so a retry can
/// only succeed once the other allocate releases the admin lock.
fn git_worktree_add_retrying(project_path: &Path, args: &[&str]) -> Result<String, String> {
    const MAX_ATTEMPTS: usize = 5;
    let mut last_err = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        match git(project_path, args) {
            Ok(out) => return Ok(out),
            Err(e) => {
                let transient = e.contains("already locked")
                    || e.contains("is already registered")
                    || e.contains("cannot lock")
                    || e.contains("File exists");
                if !transient || attempt + 1 == MAX_ATTEMPTS {
                    return Err(e);
                }
                tracing::warn!(target: "nightcore::worktree", attempt = attempt + 1, error = %e, "worktree add hit transient lock contention; retrying");
                std::thread::sleep(std::time::Duration::from_millis(50 * (attempt as u64 + 1)));
                last_err = e;
            }
        }
    }
    Err(last_err)
}

/// Remove a task's worktree (the `git worktree remove --force`). Refuses any path
/// not under the project's worktrees base. The `nc/<taskId>` branch is retained for
/// review/inspection (M2 never deletes branches). Idempotent on a missing worktree.
pub fn remove(project_path: &Path, task_id: &str) -> Result<(), String> {
    let dir = worktree_path(project_path, task_id);
    let base = worktrees_base(project_path);
    remove_worktree_dir(project_path, &dir, &base)
}

/// Remove a user-created *terminal* worktree by slug (spec PR 5) — the discard-flow
/// counterpart of [`allocate_terminal`]. Guards on the SEPARATE terminal base (not the
/// task base), and re-checks the slug is clean so a webview-supplied `../` can never
/// escape it (defence in depth with the `is_under` check below). The `term/<slug>` branch
/// is deleted by the command layer after this frees it (mirroring the task discard order).
/// Idempotent on a missing worktree.
pub fn remove_terminal(project_path: &Path, slug: &str) -> Result<(), String> {
    if !is_clean_slug(slug) {
        return Err(format!("invalid terminal worktree name {slug:?}"));
    }
    let dir = terminal_worktree_path(project_path, slug);
    let base = terminal_worktrees_base(project_path);
    remove_worktree_dir(project_path, &dir, &base)
}

/// The shared removal dance for a worktree `dir` known to belong under `base` — the
/// common body of [`remove`] (task worktrees) and [`remove_terminal`]. Refuses any path
/// not strictly under `base` (the sole guard keeping a removal inside the Nightcore
/// worktrees area), tolerates an already-gone dir (pruning git's stale admin refs), and
/// falls back to a bounded retry + manual delete when `git worktree remove` can't.
fn remove_worktree_dir(project_path: &Path, dir: &Path, base: &Path) -> Result<(), String> {
    if !is_under(base, dir) {
        return Err(format!(
            "refusing to remove {} — not under the Nightcore worktrees base",
            dir.display()
        ));
    }
    if !dir.exists() {
        // The dir was removed out-of-band (a manual `rm -rf`, a crash, an older
        // build). Git still holds stale admin refs under `.git/worktrees/<name>`
        // that keep the branch marked "checked out" there — so a subsequent
        // `delete_branch_named` would fail with "branch is checked out at …" and
        // leave the branch (and its board tab) stranded. Prune the admin refs so
        // the branch is freely deletable and the tab fully clears. Best-effort and
        // confined to git's own admin state; can never touch the user's checkout.
        let _ = git(project_path, &["worktree", "prune"]);
        return Ok(()); // dir already gone; stale admin refs pruned
    }
    let dir_str = dir.to_string_lossy().to_string();
    // `--force` because the agent's run leaves uncommitted edits in the worktree;
    // we still keep the branch, so nothing is lost.
    if git(project_path, &["worktree", "remove", "--force", &dir_str]).is_ok() {
        return Ok(());
    }
    // `git worktree remove` can fail on a locked admin file or untracked build
    // artifacts (node_modules, macOS `.app` bundles). Fall back to a bounded retry,
    // then a manual recursive delete + `worktree prune` to clear the admin refs
    // (Aperant's cross-platform cleanup). Still confined to the `is_under`-guarded
    // dir, so this can never touch the user's main checkout.
    remove_dir_with_retry(dir)?;
    let _ = git(project_path, &["worktree", "prune"]);
    Ok(())
}

/// Recursively delete `dir` with a bounded linear backoff, tolerating the transient
/// file locks that make a first delete fail (a lingering file handle). The caller
/// has already `is_under`-guarded `dir`.
fn remove_dir_with_retry(dir: &Path) -> Result<(), String> {
    const MAX_ATTEMPTS: usize = 3;
    let mut last_err = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                last_err = e.to_string();
                if attempt + 1 < MAX_ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(
                        200 * (attempt as u64 + 1),
                    ));
                }
            }
        }
    }
    Err(format!(
        "failed to remove worktree dir {}: {last_err}",
        dir.display()
    ))
}

/// List the task ids that currently have a Nightcore worktree on disk under the
/// base. Reads the directory rather than parsing `git worktree list` so it stays
/// robust to git admin-file drift; `git worktree prune` (in [`reconcile`]) cleans
/// the admin side.
pub fn list_worktree_task_ids(project_path: &Path) -> Vec<String> {
    let base = worktrees_base(project_path);
    let mut ids = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    ids.push(name.to_string());
                }
            }
        }
    }
    ids
}

/// List the slugs of the user-created *terminal* worktrees on disk under the separate
/// terminal base (spec PR 5). Mirrors [`list_worktree_task_ids`] but reads the `term/`
/// base, so these never mix with the task worktrees the board monitor + [`reconcile`]
/// enumerate. Robust to git admin-file drift (reads dir names, not `git worktree list`).
pub fn list_terminal_worktree_slugs(project_path: &Path) -> Vec<String> {
    let base = terminal_worktrees_base(project_path);
    let mut slugs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    slugs.push(name.to_string());
                }
            }
        }
    }
    slugs
}

/// Startup reconciliation: remove worktrees whose task id is no longer live, then
/// `git worktree prune` to clear stale admin files. Returns the ids it pruned. Errors
/// on individual removes are logged and skipped so one bad worktree can't block
/// startup.
///
/// `is_live` is a PREDICATE, not a snapshot (#407): it is evaluated immediately before
/// each removal, so a task created (and given a worktree) while the sweep is running
/// can never be pruned by a stale id list. That matters now the boot sweep runs
/// asynchronously beside a live UI, and it also closes the same window on the explicit
/// `refresh_worktrees` path, which always ran concurrently with the user.
pub fn reconcile(project_path: &Path, is_live: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut pruned = Vec::new();
    for id in list_worktree_task_ids(project_path) {
        if !is_live(&id) {
            match remove(project_path, &id) {
                Ok(()) => pruned.push(id),
                Err(e) => {
                    tracing::warn!(target: "nightcore::worktree", task_id = %id, error = %e, "worktree reconcile skipped orphan it could not remove")
                }
            }
        }
    }
    // Clear stale admin files for any worktree dir removed out-of-band.
    let _ = git(project_path, &["worktree", "prune"]);
    pruned
}
