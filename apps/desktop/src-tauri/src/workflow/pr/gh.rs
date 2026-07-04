//! The bounded `gh` spawn seam shared across the PR arc: the binary name, the
//! drained-output envelope, and the deadline-bounded runner. Phase-2/3
//! (`pr_status`, `pr_comments`) reach these through the `pr` facade.

use std::io::Write;
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
