//! `viewer_login` — the authenticated GitHub login via bounded `gh api user`,
//! for the web's own-PR affordances (e.g. knowing a review verdict will hit the
//! own-PR rule before GitHub refuses it).
//!
//! Fail-OPEN by contract: gh absent, logged out, offline, timed out, or a
//! malformed body all return `Ok(None)` — NEVER an `Err` — because the login is
//! a UX nicety the web must degrade without, not a gate. The module's
//! no-secrets-across-IPC discipline holds: a GitHub login is public profile
//! data (unlike a remote URL, which can embed credentials), and the token
//! itself never leaves `gh`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::git::gh::{run_gh_checked, GhCall, GH_BINARY};
use crate::workflow::merge::require_project;

/// Wall-clock bound on the `gh api user` spawn. Tighter than the view/create
/// bounds — a single-object profile read moves no data, and the caller
/// fail-opens anyway, so a black-holed GitHub should release the blocking
/// thread fast.
const GH_USER_TIMEOUT: Duration = Duration::from_secs(30);

/// Process-lifetime cache of a SUCCESSFULLY fetched login. Only success is
/// cached: a failure must stay uncached so a later `gh auth login` fixes the
/// answer without an app restart. A login effectively never changes within a
/// session, and the alternative is a network spawn per query.
static VIEWER_LOGIN: OnceLock<String> = OnceLock::new();

/// Pull the `login` field out of a `gh api user` JSON body. `None` on any
/// malformed shape or a blank login (a blank would poison the cache with a
/// value the own-PR checks can never match).
pub(super) fn parse_viewer_login(stdout: &str) -> Option<String> {
    let v: Value = serde_json::from_str(stdout.trim()).ok()?;
    let login = v.get("login")?.as_str()?.trim();
    if login.is_empty() {
        return None;
    }
    Some(login.to_string())
}

/// Fetch the authenticated login via bounded `gh api user` in `dir` —
/// binary-parameterized (the fake-`gh` test seam). Every failure mode — probe,
/// spawn, timeout, non-zero exit, parse — collapses to `None`; the fail-open
/// mapping lives HERE so no caller can accidentally surface an error.
pub(super) fn fetch_viewer_login_with(
    dir: &Path,
    binary: &str,
    deadline: Duration,
) -> Option<String> {
    // Fail-open: every error mode (missing gh, spawn, timeout, non-zero exit)
    // collapses to `None` via `.ok()?` so no caller can surface an error for this
    // cosmetic lookup.
    let stdout = run_gh_checked(GhCall {
        dir,
        binary,
        args: &["api", "user"],
        action: "install it to identify the signed-in GitHub user",
        subcmd: "api user",
        stdin: None,
        deadline,
        timeout_msg: "timed out reading the signed-in GitHub user",
    })
    .ok()?;
    parse_viewer_login(&stdout)
}

/// The blocking body of [`viewer_login`]: serve the cache, else fetch and cache
/// a success.
fn viewer_login_blocking(app: &AppHandle) -> Option<String> {
    if let Some(login) = VIEWER_LOGIN.get() {
        return Some(login.clone());
    }
    // cwd: the active project's root when there is one, so gh's per-repo
    // config/host resolve exactly as the user's own gh would there. `gh api
    // user` itself is repo-independent, so with no active project any existing
    // dir serves — never a refusal for a cosmetic lookup.
    let dir = match require_project(app) {
        Ok(project) => PathBuf::from(&project.path),
        Err(_) => std::env::temp_dir(),
    };
    let login = fetch_viewer_login_with(&dir, GH_BINARY, GH_USER_TIMEOUT)?;
    // A losing racer fetched the same account's login; first write wins.
    let _ = VIEWER_LOGIN.set(login.clone());
    Some(login)
}

/// The authenticated GitHub login (`gh api user`), or `None` when it cannot be
/// determined — NEVER an `Err` (the web fail-opens; see the module doc). Runs
/// off the UI thread (the network `gh` spawn must not block the WKWebView).
#[tauri::command]
pub async fn viewer_login(app: AppHandle) -> Result<Option<String>, String> {
    // Even a failed blocking-pool join maps to Ok(None) — the command's whole
    // contract is that nothing about it can error.
    Ok(
        tauri::async_runtime::spawn_blocking(move || viewer_login_blocking(&app))
            .await
            .unwrap_or(None),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_viewer_login_reads_the_login_field() {
        assert_eq!(
            parse_viewer_login(r#"{"login":"octocat","id":1,"type":"User"}"#).as_deref(),
            Some("octocat")
        );
        // gh output can carry trailing whitespace; the parse trims.
        assert_eq!(
            parse_viewer_login("  {\"login\":\"octocat\"}\n").as_deref(),
            Some("octocat")
        );
    }

    #[test]
    fn parse_viewer_login_maps_every_malformed_shape_to_none() {
        // Fail-open: garbage, a missing/blank login, and non-string shapes are
        // all None — never a panic, never an Err a caller could surface.
        assert_eq!(parse_viewer_login("not json"), None);
        assert_eq!(parse_viewer_login(""), None);
        assert_eq!(parse_viewer_login(r#"{"id":1}"#), None);
        assert_eq!(parse_viewer_login(r#"{"login":""}"#), None);
        assert_eq!(parse_viewer_login(r#"{"login":"   "}"#), None);
        assert_eq!(parse_viewer_login(r#"{"login":7}"#), None);
        assert_eq!(parse_viewer_login(r#"{"login":null}"#), None);
    }

    /// Write an executable shell script to stand in for `gh` (the PR-arc
    /// fixture pattern), exercising the real spawn + exit-code mapping.
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
    fn fetch_viewer_login_parses_a_success_and_carries_the_api_user_argv() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "printf '%s\\n' \"$@\" > args.txt\necho '{\"login\":\"octocat\",\"id\":1}'",
        );
        let login = fetch_viewer_login_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            Duration::from_secs(10),
        );
        assert_eq!(login.as_deref(), Some("octocat"));
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args.txt");
        let args: Vec<&str> = args.lines().collect();
        assert_eq!(args, vec!["api", "user"], "the exact bounded-gh argv");
    }

    #[test]
    #[cfg(unix)]
    fn fetch_viewer_login_maps_a_gh_failure_to_none_not_an_error() {
        // The logged-out case: `gh api user` exits non-zero. Fail-open — the
        // stderr is discarded, never surfaced.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "echo 'gh: To get started with GitHub CLI, please run: gh auth login' >&2\nexit 1",
        );
        assert_eq!(
            fetch_viewer_login_with(
                tmp.path(),
                script.to_str().expect("utf8 path"),
                Duration::from_secs(10),
            ),
            None
        );
    }

    #[test]
    #[cfg(unix)]
    fn fetch_viewer_login_maps_garbage_output_to_none() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(tmp.path(), "echo 'this is not json'");
        assert_eq!(
            fetch_viewer_login_with(
                tmp.path(),
                script.to_str().expect("utf8 path"),
                Duration::from_secs(10),
            ),
            None
        );
    }

    #[test]
    fn fetch_viewer_login_maps_an_absent_gh_to_none() {
        // The probe failure (gh not installed) is the archetypal fail-open
        // case: None, not an install-guidance Err like the string seams.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        assert_eq!(
            fetch_viewer_login_with(
                tmp.path(),
                "definitely-not-a-real-binary-xyz",
                Duration::from_secs(1),
            ),
            None
        );
    }
}
