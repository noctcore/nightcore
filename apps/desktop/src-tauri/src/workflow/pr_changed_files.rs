//! `pr_changed_files` — a read-only `gh pr view <n> --json files` for the PR Review
//! detail pane, so the UI can render a PR's changed-file list (path + per-file
//! additions/deletions) without shipping the whole diff.
//!
//! Same posture as the rest of the `gh` seam: bounded by a deadline via
//! [`super::pr::run_gh_bounded`]; `gh` is the seam and stores no tokens; the repo is the
//! active project's; every `path` is gh pass-through (untrusted contributor content) the
//! web renders as inert text and never feeds to a model. Read-only — no mutation, no
//! lease. The list is CAPPED defensively (a pathological PR touching tens of thousands of
//! files must not blow the IPC payload / render budget).

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use super::merge::require_project;
use super::pr::{map_gh_failure, probe_gh, run_gh_bounded, GH_BINARY};

const GH_FILES_TIMEOUT: Duration = Duration::from_secs(60);
/// The `--json` field set for the changed-file list — path + line-delta counts only.
const PR_FILES_FIELDS: &str = "files";
/// Defensive ceiling on the returned list: past this we truncate rather than ship an
/// unbounded payload for a pathological PR. The picker/detail pane shows the leading slice.
const PR_FILES_CAP: usize = 500;

/// One changed file in a pull request (path + per-file line deltas). `path` is gh
/// pass-through (any contributor's content) — inert display only, never a model input,
/// never shell-interpolated.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PrChangedFile.ts"))]
pub struct PrChangedFile {
    /// Repo-relative path of the changed file (gh vocabulary).
    pub path: String,
    /// Lines added in this file per the PR diff.
    pub additions: u32,
    /// Lines removed in this file per the PR diff.
    pub deletions: u32,
}

/// The `gh pr view --json files` payload: `{ "files": [ {path, additions, deletions}, … ] }`.
/// Every field beyond `path` is optional with a safe default, so gh drift degrades a row —
/// never the whole list.
#[derive(Debug, serde::Deserialize)]
struct GhFilesView {
    #[serde(default)]
    files: Vec<GhChangedFile>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhChangedFile {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    additions: Option<u32>,
    #[serde(default)]
    deletions: Option<u32>,
}

impl GhChangedFile {
    fn into_changed(self) -> PrChangedFile {
        PrChangedFile {
            path: self.path.unwrap_or_default(),
            additions: self.additions.unwrap_or(0),
            deletions: self.deletions.unwrap_or(0),
        }
    }
}

/// Parse `gh pr view --json files` stdout into the wire contract, CAPPED at
/// [`PR_FILES_CAP`]. Pure + unit-tested. An empty body degrades to an empty list.
fn parse_changed_files(stdout: &str) -> Result<Vec<PrChangedFile>, String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let view: GhFilesView = serde_json::from_str(trimmed)
        .map_err(|e| format!("could not parse gh pr view --json files output: {e}"))?;
    Ok(view
        .files
        .into_iter()
        .take(PR_FILES_CAP)
        .map(GhChangedFile::into_changed)
        .collect())
}

/// The bounded seam — `binary`-parameterized so tests inject a fake `gh`. `pr_number` is
/// a `u64` rendered decimal (injection-safe).
fn changed_files_with(
    dir: &Path,
    binary: &str,
    pr_number: u64,
    deadline: Duration,
) -> Result<Vec<PrChangedFile>, String> {
    if pr_number == 0 {
        return Err("enter a valid PR number (a positive integer)".to_string());
    }
    probe_gh(binary, "install it to list a pull request's changed files")?;
    let number = pr_number.to_string();
    let out = run_gh_bounded(
        dir,
        binary,
        &["pr", "view", &number, "--json", PR_FILES_FIELDS],
        None,
        deadline,
        "timed out reading the PR's changed files from GitHub — check your network and try again",
    )?;
    if !out.status.success() {
        return Err(map_gh_failure(binary, "pr view", &out));
    }
    parse_changed_files(&out.stdout)
}

fn pr_changed_files_blocking(
    app: &AppHandle,
    pr_number: u64,
) -> Result<Vec<PrChangedFile>, String> {
    let project = require_project(app)?;
    let dir = std::path::PathBuf::from(&project.path);
    changed_files_with(&dir, GH_BINARY, pr_number, GH_FILES_TIMEOUT)
}

/// List a pull request's changed files (path + line deltas) for the PR Review detail
/// pane. Runs off the UI thread (the network `gh` spawn must not block the WKWebView).
#[tauri::command]
pub async fn pr_changed_files(app: AppHandle, number: u64) -> Result<Vec<PrChangedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || pr_changed_files_blocking(&app, number))
        .await
        .map_err(|e| format!("list changed files failed to run: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_changed_files_reads_path_and_line_deltas() {
        let json = r#"{"files":[
            {"path":"src/a.ts","additions":10,"deletions":2},
            {"path":"src/b.rs"}
        ]}"#;
        let files = parse_changed_files(json).expect("parses");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/a.ts");
        assert_eq!(files[0].additions, 10);
        assert_eq!(files[0].deletions, 2);
        // A row missing everything but its path degrades to zero deltas, not a drop.
        assert_eq!(files[1].path, "src/b.rs");
        assert_eq!((files[1].additions, files[1].deletions), (0, 0));
    }

    #[test]
    fn parse_changed_files_empty_and_absent_files_are_empty_lists() {
        assert_eq!(parse_changed_files("").expect("ok"), Vec::new());
        assert_eq!(parse_changed_files("   \n").expect("ok"), Vec::new());
        // A `files`-less object (gh drift) degrades to an empty list, not an error.
        assert_eq!(parse_changed_files("{}").expect("ok"), Vec::new());
        assert_eq!(
            parse_changed_files(r#"{"files":[]}"#).expect("ok"),
            Vec::new()
        );
    }

    #[test]
    fn parse_changed_files_malformed_json_is_an_error_not_a_panic() {
        assert!(parse_changed_files("not json").is_err());
        // A scalar can't become the `{files:[…]}` object — an error, never a panic. (A
        // bare `[]` is tolerated: serde reads a struct from a positional array, yielding
        // the default empty `files`, which is the same graceful empty-list outcome.)
        assert!(parse_changed_files("42").is_err());
        assert!(parse_changed_files("\"nope\"").is_err());
    }

    #[test]
    fn parse_changed_files_caps_a_pathological_list() {
        // A PR touching more files than the cap is truncated to PR_FILES_CAP, never
        // shipped whole across IPC.
        let rows: Vec<String> = (0..(PR_FILES_CAP + 50))
            .map(|i| format!(r#"{{"path":"f{i}.ts","additions":1,"deletions":0}}"#))
            .collect();
        let json = format!(r#"{{"files":[{}]}}"#, rows.join(","));
        let files = parse_changed_files(&json).expect("parses");
        assert_eq!(files.len(), PR_FILES_CAP, "the list is capped");
        assert_eq!(files[0].path, "f0.ts", "the leading slice is kept");
    }

    /// Write an executable shell script to stand in for `gh` (the fixture pattern).
    #[cfg(unix)]
    fn fake_gh(dir: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-gh.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
        let mut perms = std::fs::metadata(&path).expect("meta").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod");
        path
    }

    #[test]
    #[cfg(unix)]
    fn changed_files_with_requests_the_files_field_and_parses() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "printf '%s\\n' \"$@\" >> args.txt\n\
             printf '{\"files\":[{\"path\":\"src/a.ts\",\"additions\":3,\"deletions\":1}]}'\n\
             exit 0",
        );
        let files = changed_files_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            7,
            GH_FILES_TIMEOUT,
        )
        .expect("changed files succeeds");
        assert_eq!(
            files,
            vec![PrChangedFile {
                path: "src/a.ts".into(),
                additions: 3,
                deletions: 1,
            }]
        );
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args");
        assert!(args.contains("view"), "invokes `gh pr view`: {args}");
        assert!(args.contains("7"), "passes the decimal number: {args}");
        assert!(
            args.contains(PR_FILES_FIELDS),
            "asks for the files field: {args}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn changed_files_with_surfaces_stderr_verbatim_on_failure() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_gh(
            tmp.path(),
            "echo 'gh: no default remote repository' 1>&2\nexit 1",
        );
        let err = changed_files_with(
            tmp.path(),
            script.to_str().expect("utf8 path"),
            7,
            GH_FILES_TIMEOUT,
        )
        .expect_err("a failing gh is an error");
        assert!(err.contains("no default remote repository"));
    }

    #[test]
    fn changed_files_with_rejects_zero_pr_number() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let err = changed_files_with(tmp.path(), GH_BINARY, 0, GH_FILES_TIMEOUT)
            .expect_err("pr 0 is rejected");
        assert!(err.contains("valid PR number"), "err: {err}");
    }
}
