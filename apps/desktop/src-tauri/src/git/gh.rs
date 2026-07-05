//! The consolidated `gh` (GitHub CLI) subprocess seam.
//!
//! Moved here from `workflow/pr/gh.rs` so git AND gh execution share one home:
//! the binary name, the `--json` field-set constants, the drained-output
//! envelope, the `which`-probe, the failure mapper, the bounded runner, and the
//! `run_gh_checked` / `run_gh_json` orchestration wrappers the PR arc's ~13 call
//! sites route through.
//!
//! `gh` is the GitHub seam — user-installed, `which`-probed, never bundled (the
//! `claude` / gitleaks precedent); `gh` owns auth, Nightcore stores no tokens. The
//! bounded runner shares the drain/deadline/kill core with the git + claude
//! runners ([`crate::git::run::drain_and_wait`]) and applies the SAME git-env
//! isolation `platform::git_command` uses ([`crate::platform::scrub_git_env`]) so
//! gh's inner git runs scrubbed.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

/// The GitHub CLI binary name — the production argument to the binary-
/// parameterized seams below (tests inject fake scripts instead).
pub(crate) const GH_BINARY: &str = "gh";

// ─── Centralized `--json` field sets ───────────────────────────────────────────
// One home for the PR field lists that were fragmented across pr_list /
// pr_changed_files / pr_status::view, so the `gh pr view`/`gh pr list` contract
// the UI renders lives in a single place.

/// All single-query fields for the PR picker list (`gh pr list --json`, no N+1).
/// `author` and `labels` are nested; `body`/`url` feed the detail pane;
/// `additions`/`deletions` the size badge.
pub(crate) const PR_LIST_FIELDS: &str =
    "number,title,state,headRefName,author,isDraft,createdAt,updatedAt,url,labels,body,additions,deletions";

/// The `--json` field set for a PR's changed-file list — path + line-delta counts.
pub(crate) const PR_FILES_FIELDS: &str = "files";

/// The `--json` field list for `gh pr view` — the exact shared-contract set the
/// status card renders.
pub(crate) const PR_VIEW_FIELDS: &str =
    "number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,headRefOid,statusCheckRollup";

/// The drained output of a bounded `gh` run (see [`run_gh_bounded`]).
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
/// both pipes + wait under `deadline` via the shared bounded core — `gh` talks to
/// the network, so a black-holed GitHub errors out (`timeout_msg`) instead of
/// pinning the blocking thread + PR lease forever. Errs are user-facing strings;
/// the caller decides the outcome mapping.
///
/// The command is built with the SAME git-env isolation `git_command` applies
/// ([`crate::platform::scrub_git_env`]): `gh` shells out to `git` internally, so
/// without it gh's inner git would run with an un-scrubbed env (the
/// `GIT_SSH_COMMAND` / `GIT_EXTERNAL_DIFF` / … RCE vectors + parent GIT_* context).
/// Verified the keychain-backed gh auth survives the scrub (`gh auth status` +
/// `gh api rate_limit` both pass under it, 2026-07-05).
pub(crate) fn run_gh_bounded(
    dir: &Path,
    binary: &str,
    args: &[&str],
    stdin_payload: Option<&str>,
    deadline: Duration,
    timeout_msg: &str,
) -> Result<GhOutput, String> {
    let mut command = crate::platform::std_command(binary);
    command
        .args(args)
        .current_dir(dir)
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::platform::scrub_git_env(&mut command);

    let child = match command.spawn() {
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
    // (the drained-pipe/deadline/kill mechanics the git + claude runners share).
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

/// A checked `gh` call — the probe → run-bounded → status-check orchestration the
/// PR arc repeats at ~13 sites, grouped so callers name their fields instead of
/// threading positional args. Build one and hand it to [`run_gh_checked`] /
/// [`run_gh_json`].
pub(crate) struct GhCall<'a> {
    /// Working dir for the spawn (the project root or a task worktree).
    pub(crate) dir: &'a Path,
    /// The `gh` binary — production [`GH_BINARY`]; tests inject a fake script path.
    pub(crate) binary: &'a str,
    /// The `gh` args, e.g. `["pr", "list", "--json", PR_LIST_FIELDS]`.
    pub(crate) args: &'a [&'a str],
    /// The `probe_gh` install-hint action, e.g. "install it to list pull requests".
    pub(crate) action: &'a str,
    /// The subcommand label for the failure message, e.g. "pr list".
    pub(crate) subcmd: &'a str,
    /// Optional stdin (e.g. a review body / GraphQL query on `--input -`).
    pub(crate) stdin: Option<&'a str>,
    pub(crate) deadline: Duration,
    /// The user-facing message when the run overruns `deadline`.
    pub(crate) timeout_msg: &'a str,
}

/// Probe → run-bounded → status-check the common `gh` call, returning its stdout
/// on success or a user-facing error (missing `gh` / timeout / mapped non-zero
/// exit via [`map_gh_failure`]). The single home for the orchestration every
/// straightforward `gh` read/post site used to inline. Sites with bespoke
/// exit-code semantics (`gh pr checks` exits non-zero when checks fail) or a
/// custom failure mapper keep using the [`run_gh_bounded`] primitive directly.
pub(crate) fn run_gh_checked(call: GhCall) -> Result<String, String> {
    probe_gh(call.binary, call.action)?;
    let out = run_gh_bounded(
        call.dir,
        call.binary,
        call.args,
        call.stdin,
        call.deadline,
        call.timeout_msg,
    )?;
    if !out.status.success() {
        return Err(map_gh_failure(call.binary, call.subcmd, &out));
    }
    Ok(out.stdout)
}

/// [`run_gh_checked`] + JSON deserialization of the (trimmed) stdout into `T`. The
/// `--json` readers (status view, PR refs, head OID) route through this.
pub(crate) fn run_gh_json<T: serde::de::DeserializeOwned>(call: GhCall) -> Result<T, String> {
    let (binary, subcmd) = (call.binary.to_string(), call.subcmd.to_string());
    let stdout = run_gh_checked(call)?;
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("`{binary} {subcmd}` returned unparseable JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gh runner must apply the SAME git-env isolation `git_command` uses
    /// ([`crate::platform::scrub_git_env`]) so gh's inner git runs scrubbed: a fake
    /// `gh` observes the pinned `GIT_TERMINAL_PROMPT=0` / `LC_ALL=C` on its env. This
    /// is the security decision made 2026-07-05 (verified `gh auth status` + `gh api
    /// rate_limit` still pass under the scrub); the assertion guards against a future
    /// change silently reverting the gh runner to an un-scrubbed spawn.
    #[test]
    #[cfg(unix)]
    fn run_gh_bounded_applies_git_env_isolation() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;

        let tmp = tempfile::TempDir::new().expect("tempdir");
        let script = tmp.path().join("fake-gh.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf 'PROMPT=%s LC=%s\\n' \"$GIT_TERMINAL_PROMPT\" \"$LC_ALL\"\n",
        )
        .expect("write fake gh");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        let out = run_gh_bounded(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            &[],
            None,
            Duration::from_secs(10),
            "timed out",
        )
        .expect("fake gh runs");
        assert!(
            out.status.success(),
            "fake gh exited non-zero: {}",
            out.stderr
        );
        assert!(
            out.stdout.contains("PROMPT=0"),
            "gh runner must pin GIT_TERMINAL_PROMPT=0 (env-scrub applied): {}",
            out.stdout
        );
        assert!(
            out.stdout.contains("LC=C"),
            "gh runner must pin LC_ALL=C (env-scrub applied): {}",
            out.stdout
        );
    }
}
