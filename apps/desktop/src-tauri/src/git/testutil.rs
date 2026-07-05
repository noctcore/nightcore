//! Shared test-only git fixture runner + the guard that keeps raw git spawns here.
//!
//! Test fixtures across the crate build real temp git repos; they route their
//! setup + assertion git commands through [`git_ok`] / [`git_expect`] /
//! [`git_stdout`] so the raw `git` spawn lives in exactly ONE place instead of the
//! ~30 hand-rolled copies that were scattered across the test modules. The runner
//! pins a deterministic author/committer identity so a fixture `git commit`
//! succeeds even on a host with no global `user.name` / `user.email`.
//!
//! [`no_raw_git_spawn_outside_the_fixture_helper`] is the guard: `platform::git_command`
//! is the single git-env isolation chokepoint, so no code — production OR test —
//! may spawn git with its own `std::process::Command`, except this fixture helper.

#![cfg(test)]

use std::path::Path;
use std::process::Command;

/// Build a `git <args>` fixture command in `dir` with a fixed, HERMETIC identity.
/// The ONE sanctioned raw `git` spawn outside `platform::git_command` — the guard
/// below scans the crate's sources to enforce that. We pin a deterministic
/// author/committer (so a `git commit` works with no host `user.name`/`email`) and
/// point the global/system config at `/dev/null` so a fixture never depends on the
/// developer's or CI host's git config (aliases, hooks, merge drivers) — the
/// isolation the pr_fix conflict fixtures already needed, applied to all of them.
fn git_cmd(dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "nightcore-test")
        .env("GIT_AUTHOR_EMAIL", "test@nightcore.local")
        .env("GIT_COMMITTER_NAME", "nightcore-test")
        .env("GIT_COMMITTER_EMAIL", "test@nightcore.local")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null");
    cmd
}

/// Run `git <args>` in `dir`, returning whether it succeeded (spawn failure ⇒
/// `false`). For fixture setup steps whose success is optional or checked inline.
pub(crate) fn git_ok(dir: &Path, args: &[&str]) -> bool {
    git_cmd(dir, args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// [`git_ok`] that asserts success — for fixture setup where a failed git command
/// means the test's premise (a real repo) never got built.
pub(crate) fn git_expect(dir: &Path, args: &[&str]) {
    assert!(
        git_ok(dir, args),
        "git {args:?} failed in {}",
        dir.display()
    );
}

/// Run `git <args>` in `dir` and return its trimmed stdout — for fixtures that
/// read back state (`log`, `rev-list`, `diff --name-only`, `ls-files`, `rev-parse`).
/// Panics if git cannot be spawned (the fixture can't proceed without it).
pub(crate) fn git_stdout(dir: &Path, args: &[&str]) -> String {
    let out = git_cmd(dir, args)
        .output()
        .unwrap_or_else(|e| panic!("git {args:?} failed to spawn in {}: {e}", dir.display()));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// GUARD: `platform::git_command` is the single git-env isolation chokepoint (it
/// scrubs the `GIT_*` + code-execution env vectors and neutralizes repo-local exec
/// config). No production code may spawn git another way, and no test may either
/// except this fixture helper. Scan the crate's own sources: the raw git-spawn
/// needle may appear ONLY in this file. A Rust test — deliberately NOT a lint-meta
/// rule (the CI Bun lint job has no Tauri deps); precedent: the injection-scan
/// neutralizer tests.
#[test]
fn no_raw_git_spawn_outside_the_fixture_helper() {
    // Build the needle at runtime so THIS file's source doesn't itself contain the
    // literal (which would be a self-match), then walk `src/` for offenders.
    let needle = format!("Command::new({:?})", "git");
    let src_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders = Vec::new();
    visit_rs_files(&src_dir, &mut |path, contents| {
        // This helper is the ONE sanctioned home for a raw git spawn.
        if path.ends_with("git/testutil.rs") {
            return;
        }
        if contents.contains(&needle) {
            offenders.push(path.display().to_string());
        }
    });
    assert!(
        offenders.is_empty(),
        "raw `git` spawn found outside the chokepoint — route it through \
         crate::platform::git_command (production) or crate::git::testutil (tests): {offenders:#?}"
    );
}

/// Recurse `dir`, calling `f(path, contents)` for every `.rs` file.
#[cfg(test)]
fn visit_rs_files(dir: &Path, f: &mut impl FnMut(&Path, &str)) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            visit_rs_files(&path, f);
        } else if path.extension().is_some_and(|e| e == "rs") {
            if let Ok(contents) = std::fs::read_to_string(&path) {
                f(&path, &contents);
            }
        }
    }
}
