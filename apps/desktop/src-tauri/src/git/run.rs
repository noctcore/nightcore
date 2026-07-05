//! The shared git subprocess runners.
//!
//! Every git spawn in the crate builds on the git-env isolation chokepoint
//! `platform::git_command` (which scrubs the `GIT_*` + code-execution env
//! vectors and neutralizes repo-local exec config). These helpers add the common
//! spawn → status-check → trim discipline on top so consumers stop re-rolling it
//! (the verbatim `git_stdout` triplicate the verification gates each carried).

use std::path::Path;

/// Run a git subcommand in `dir` for its trimmed stdout, `None` on any failure —
/// a spawn error OR a non-zero exit. Callers that gate on git output treat every
/// `None` as "skip". Routed through the env-scrubbed `platform::git_command` like
/// every git spawn in the crate, so a poisoned parent env or a hostile repo-local
/// `.git/config` (`core.fsmonitor=<cmd>`, …) can't turn the read into host code
/// execution.
///
/// A successful-but-empty read returns `Some(String::new())`; a caller that wants
/// empty-as-absent maps it with `.filter(|s| !s.is_empty())`.
pub(crate) fn git_stdout(dir: &Path, args: &[&str]) -> Option<String> {
    let out = crate::platform::git_command(dir).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
