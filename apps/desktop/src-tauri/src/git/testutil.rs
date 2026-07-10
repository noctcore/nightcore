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
/// below scans the crate's sources to enforce that.
///
/// CONFINEMENT (why the env scrub): a fixture only sets `.current_dir(dir)` (a
/// TempDir), but `current_dir` alone does NOT win against an inherited `GIT_DIR` /
/// `GIT_WORK_TREE` / `GIT_INDEX_FILE` — git resolves the repo from those env vars
/// FIRST, so a fixture `git config user.email …` or `git init --bare` would then
/// silently retarget the REAL repo the test runs inside. Git exports exactly those
/// vars when `cargo test` runs from a pre-push/pre-commit hook (the gate battery),
/// so an un-scrubbed fixture writes `user.name=t` / `user.email=t@t.t` into the
/// developer's `.git/config` and flips `core.bare=true`. We apply the SAME
/// isolation the production seam uses ([`crate::platform::scrub_git_env`], which
/// clears the repo-location + author + code-execution vectors) so every fixture git
/// call is pinned to `dir` regardless of the ambient environment.
///
/// After scrubbing we re-pin a deterministic author/committer (scrub cleared the
/// inherited ones, so a fixture `git commit` still works with no host
/// `user.name`/`email`) and point the global/system config at `/dev/null` so a
/// fixture never depends on the developer's or CI host's git config.
fn git_cmd(dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(dir);
    // Confine to `dir`: strip any inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE (and
    // the author + code-execution vectors) so the ambient env can't redirect the spawn.
    crate::platform::scrub_git_env(&mut cmd);
    // Re-pin the hermetic fixture identity + neutralize the host global/system config
    // (these `.env` sets run AFTER the scrub's `.env_remove`, so they win).
    cmd.env("GIT_AUTHOR_NAME", "nightcore-test")
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

/// REGRESSION GUARD: a fixture git spawn must be CONFINED to its `current_dir`.
/// An inherited `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` (git exports these
/// when `cargo test` runs from a pre-push/pre-commit hook) overrides `current_dir`,
/// so an un-scrubbed fixture `git config user.email t@t.t` / `git init --bare`
/// silently retargets the developer's REAL repo — writing `user.name=t` and
/// flipping `core.bare=true`. Assert the built command removes the repo-location
/// vars (and still carries the pinned hermetic identity). Deterministic + parallel
/// safe: it inspects the Command's env map, never the process env or a real repo.
#[test]
fn git_cmd_scrubs_ambient_repo_location_env() {
    use std::collections::HashMap;
    use std::ffi::OsStr;
    let cmd = git_cmd(Path::new("/tmp"), &["status"]);
    let envs: HashMap<&OsStr, Option<&OsStr>> = cmd.get_envs().collect();
    // The repo-location vars that would otherwise redirect the spawn off `dir`.
    for var in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] {
        assert_eq!(
            envs.get(OsStr::new(var)),
            Some(&None),
            "{var} must be scrubbed so `current_dir` wins (else fixtures leak into the real repo)"
        );
    }
    // The hermetic identity survives the scrub (re-pinned after it), so a fixture
    // `git commit` still works on a host with no `user.name`/`email`.
    assert_eq!(
        envs.get(OsStr::new("GIT_AUTHOR_NAME")),
        Some(&Some(OsStr::new("nightcore-test"))),
        "the pinned fixture identity must survive the env scrub"
    );
    assert_eq!(
        envs.get(OsStr::new("GIT_CONFIG_GLOBAL")),
        Some(&Some(OsStr::new("/dev/null"))),
    );
    assert_eq!(cmd.get_current_dir(), Some(Path::new("/tmp")));
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
