//! The bounded `gh` spawn seam shared across the PR arc: the binary name, the
//! drained-output envelope, and the deadline-bounded runner. Phase-2/3
//! (`pr_status`, `pr_comments`) reach these through the `pr` facade.

use std::path::Path;
use std::process::Stdio;

/// The GitHub CLI binary name — the production argument to the binary-
/// parameterized seams below (tests inject fake scripts instead). Shared with
/// the phase-2 status/finalize commands (`pr_status.rs`).
pub(crate) const GH_BINARY: &str = "gh";

/// The drained output of a bounded `gh` run (see [`run_gh_bounded`]). Shared
/// with the phase-2 status/finalize commands (`pr_status.rs`).
pub(crate) struct GhOutput {
    pub(crate) status: std::process::ExitStatus,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

/// The `which`-probe every string-returning `gh` seam runs before spawning: a
/// missing `gh` reads as a clear install message (`action_msg` names what the
/// caller was doing, e.g. "install it to list pull requests"), and a spawn-time
/// NotFound AFTER a green probe reads as the vanished-cwd launch failure it
/// actually is ([`run_gh_bounded`]'s mapping) — never as a missing tool. `which`
/// is PATHEXT-aware, so a Windows `cmd /C <name>` fallback that would
/// spawn-succeed-then-exit-nonzero can't misread "gh absent" as a command
/// failure. (The enum-returning create seam keeps its own `ToolAbsent` probe.)
pub(crate) fn probe_gh(binary: &str, action_msg: &str) -> Result<(), String> {
    if which::which(binary).is_err() {
        return Err(format!("GitHub CLI (`gh`) is not installed — {action_msg}"));
    }
    Ok(())
}

/// Map a non-zero `gh <subcmd>` exit to a user-facing string: prefer `gh`'s own
/// stderr (it explains itself — auth, rate limit, unknown repo, …) and fall back
/// to a synthetic "`gh <subcmd>` failed (exit N)" when stderr is empty. Call only
/// after `!out.status.success()`.
pub(crate) fn map_gh_failure(binary: &str, subcmd: &str, out: &GhOutput) -> String {
    let stderr = out.stderr.trim();
    if stderr.is_empty() {
        format!("`{binary} {subcmd}` failed (exit {:?})", out.status.code())
    } else {
        stderr.to_string()
    }
}

/// Spawn `binary args…` in `dir` (feeding `stdin_payload` when given), drain
/// both pipes on threads, and wait under `deadline` — `gh` talks to the
/// network, so a black-holed GitHub errors out (`timeout_msg`) instead of
/// pinning the blocking thread + PR lease forever. Errs are user-facing
/// strings; the caller decides the outcome mapping.
pub(crate) fn run_gh_bounded(
    dir: &Path,
    binary: &str,
    args: &[&str],
    stdin_payload: Option<&str>,
    deadline: std::time::Duration,
    timeout_msg: &str,
) -> Result<GhOutput, String> {
    let child = match crate::platform::std_command(binary)
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

    // Feed stdin + drain both pipes + bound the wait via the shared runner core
    // (the drained-pipe/deadline/kill mechanics `git_with_deadline` and the claude
    // one-shot share). The spawn above stays bespoke (gh's own cwd + error mapping).
    match crate::git::run::drain_and_wait(child, stdin_payload.map(str::as_bytes), deadline) {
        Ok(Some(out)) => Ok(GhOutput {
            status: out.status,
            stdout: out.stdout,
            stderr: out.stderr,
        }),
        Ok(None) => Err(timeout_msg.to_string()),
        Err(e) => Err(format!("`{binary}` did not finish: {e}")),
    }
}
