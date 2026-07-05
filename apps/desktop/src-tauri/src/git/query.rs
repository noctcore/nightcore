//! Small reusable git READS shared across the analysis + verification + scan
//! consumers, so they stop hand-building `git_command(...).args([...])` inline at
//! each site. Read-only; each returns owned repo-relative paths and builds on the
//! same `platform::git_command` chokepoint (via [`crate::git::run`] + the parsers).

use std::path::Path;

/// The git-tracked files under `root` matching `pathspec` (empty ⇒ all tracked),
/// as repo-relative paths. Runs `git ls-files -z` — NUL-delimited so paths with
/// spaces/newlines stay intact — split with [`crate::git::parse::parse_ls_files_z`].
/// `Err` (spawn message / stderr) on a git failure so a caller can distinguish
/// "git failed" from "no tracked files"; a fail-open reader maps it with `.ok()`.
pub(crate) fn list_tracked_files(root: &Path, pathspec: &[&str]) -> Result<Vec<String>, String> {
    let mut args: Vec<&str> = vec!["ls-files", "-z"];
    if !pathspec.is_empty() {
        args.push("--");
        args.extend_from_slice(pathspec);
    }
    let out = crate::platform::git_command(root)
        .args(&args)
        .output()
        .map_err(|e| format!("failed to run git (is `git` on PATH?): {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let listing = String::from_utf8_lossy(&out.stdout);
    Ok(crate::git::parse::parse_ls_files_z(&listing)
        .into_iter()
        .map(str::to_string)
        .collect())
}

/// The changed files for a "diff" analysis scope: tracked changes vs `HEAD`
/// (`git diff --name-only HEAD`) PLUS untracked-but-not-ignored files
/// (`ls-files --others --exclude-standard`), sorted + deduped. Best-effort — a
/// non-repo / git failure yields fewer (or zero) entries, never an error (the
/// caller falls back to exploring the whole repo). Repo-relative paths.
pub(crate) fn changed_files_vs_head(root: &Path) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for args in [
        &["diff", "--name-only", "HEAD"][..],
        &["ls-files", "--others", "--exclude-standard"][..],
    ] {
        if let Some(out) = crate::git::run::git_stdout(root, args) {
            for line in out.lines() {
                let line = line.trim();
                if !line.is_empty() {
                    files.push(line.to_string());
                }
            }
        }
    }
    files.sort();
    files.dedup();
    files
}
