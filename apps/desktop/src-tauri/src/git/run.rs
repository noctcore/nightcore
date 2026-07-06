//! The shared git subprocess runners + the bounded-subprocess core.
//!
//! Every git spawn in the crate builds on the git-env isolation chokepoint
//! `platform::git_command` (which scrubs the `GIT_*` + code-execution env
//! vectors and neutralizes repo-local exec config). These helpers add the common
//! spawn → status-check → trim discipline on top so consumers stop re-rolling it.
//!
//! [`drain_and_wait`] is the ONE bounded-subprocess core shared by the three
//! network/hang-prone runners that used to each re-implement the drained-pipe +
//! deadline + kill dance: the git `git_with_deadline` here, the `gh` seam
//! (`git::gh`), and the `claude -p` one-shot (`workflow::oneshot`). It owns
//! ONLY the drain/deadline/kill mechanics —
//! each caller keeps its own env-configured spawn (so the git-env chokepoint, the
//! gh credential path, and claude's least-privilege arg building all stay
//! bespoke) and its own outcome mapping.

use std::io::{Read, Write};
use std::path::Path;
use std::process::Child;
use std::time::Duration;

/// The drained output of a bounded subprocess run (see [`drain_and_wait`]).
pub(crate) struct BoundedOutput {
    pub(crate) status: std::process::ExitStatus,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

/// Feed an already-spawned `child` its `stdin_payload` (from a detached thread so
/// a large body can't deadlock against a child that is also writing output),
/// drain BOTH its stdout and stderr pipes on threads (so neither can fill and
/// block the child), and wait under `deadline` via [`crate::proc::wait_with_deadline`]
/// (which kills + reaps on overrun, closing the pipes so the drain threads finish).
///
/// Returns:
/// - `Ok(Some(BoundedOutput))` — the child exited within the deadline;
/// - `Ok(None)` — the deadline elapsed (child killed + reaped);
/// - `Err(e)` — the wait itself failed (child killed + reaped).
///
/// The caller owns the spawn: it sets the command's env/cwd/args and its stdio
/// piping, so a pipe configured as `Stdio::null()` (e.g. claude's stderr) simply
/// drains to an empty string. This is the shared half of the git/gh/claude
/// bounded runners; the caller maps the three arms to its own error/None posture.
pub(crate) fn drain_and_wait(
    mut child: Child,
    stdin_payload: Option<&[u8]>,
    deadline: Duration,
) -> std::io::Result<Option<BoundedOutput>> {
    // Feed stdin from a detached thread (dropping the handle closes the pipe / EOF).
    if let (Some(payload), Some(mut stdin)) = (stdin_payload, child.stdin.take()) {
        let payload = payload.to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&payload);
        });
    }

    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<String> {
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

    match crate::proc::wait_with_deadline(&mut child, deadline)? {
        Some(status) => Ok(Some(BoundedOutput {
            status,
            stdout: stdout.join().unwrap_or_default(),
            stderr: stderr.join().unwrap_or_default(),
        })),
        None => Ok(None),
    }
}

/// Run a git subcommand in `repo`, returning trimmed stdout on success or the
/// trimmed stderr as the error. The unbounded runner every non-network git read
/// routes through (the network ones use [`git_with_deadline`]).
pub(crate) fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::platform::git_command(repo)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git (is `git` on PATH?): {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Run a git subcommand in `dir` for its trimmed stdout, `None` on any failure —
/// a spawn error OR a non-zero exit. Callers that gate on git output treat every
/// `None` as "skip". Thin [`git`]`.ok()` wrapper, so it shares the exact
/// chokepoint + trim discipline; a successful-but-empty read returns
/// `Some(String::new())` (map with `.filter(|s| !s.is_empty())` for empty-as-absent).
pub(crate) fn git_stdout(dir: &Path, args: &[&str]) -> Option<String> {
    git(dir, args).ok()
}

/// Like [`git`], but bounded by a wall-clock `deadline` — for subcommands that
/// talk to the NETWORK (`push`, `fetch`), where a black-holed origin would
/// otherwise pin the calling blocking thread (and any task lease it holds)
/// forever. Same chokepoint (`platform::git_command`, so the git-env isolation is
/// preserved), spawned with piped output drained + reaped via the shared
/// [`drain_and_wait`] core; on overrun the child is killed and `timeout_msg` is
/// returned as the error.
pub(crate) fn git_with_deadline(
    repo: &Path,
    args: &[&str],
    deadline: Duration,
    timeout_msg: &str,
) -> Result<String, String> {
    use std::process::Stdio;
    let child = crate::platform::git_command(repo)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run git (is `git` on PATH?): {e}"))?;
    match drain_and_wait(child, None, deadline) {
        Ok(Some(out)) if out.status.success() => Ok(out.stdout.trim().to_string()),
        Ok(Some(out)) => Err(out.stderr.trim().to_string()),
        Ok(None) => Err(timeout_msg.to_string()),
        Err(e) => Err(format!("git did not finish: {e}")),
    }
}

/// Run a git subcommand purely for its exit status (no output capture). Returns
/// true on success. Used for predicate-style git calls (`diff --quiet`, `merge`).
pub(crate) fn git_status_success(repo: &Path, args: &[&str]) -> bool {
    crate::platform::git_command(repo)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
