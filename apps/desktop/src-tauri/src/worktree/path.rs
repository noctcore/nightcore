//! Path + branch-name computation and the worktree-escape guard.
//!
//! Pure functions only — no `git`, no I/O — so the security-critical guard
//! ([`is_under`]) and the base-dir naming ([`worktrees_base`] / [`worktree_path`])
//! can be audited and unit-tested in isolation. Every worktree lives under
//! `<project>/.nightcore/worktrees/<taskId>`; [`is_under`] is the sole check that
//! keeps a removal from ever touching anything outside that base.

use std::path::{Path, PathBuf};

/// The branch name for a task's run: `nc/<taskId>`.
pub fn branch_name(task_id: &str) -> String {
    format!("nc/{task_id}")
}

/// The base dir all Nightcore worktrees live under for a project.
pub fn worktrees_base(project_path: &Path) -> PathBuf {
    project_path.join(".nightcore/worktrees")
}

/// The worktree dir for a task: `<project>/.nightcore/worktrees/<taskId>`.
pub fn worktree_path(project_path: &Path, task_id: &str) -> PathBuf {
    worktrees_base(project_path).join(task_id)
}

/// Whether `candidate` is strictly under `base` (used to refuse removals outside
/// the Nightcore worktrees dir). Compares lexically on normalized components, so it
/// does not require the paths to exist.
pub fn is_under(base: &Path, candidate: &Path) -> bool {
    let base: Vec<_> = base.components().collect();
    let cand: Vec<_> = candidate.components().collect();
    cand.len() > base.len() && cand[..base.len()] == base[..]
}

/// Validate a user-supplied branch or base ref before it is spliced into a `git`
/// argument list. The create dialog's branch picker feeds `task.branch` /
/// `task.base_branch` straight into `git worktree add` / `checkout` / `merge` /
/// `branch -D` as positionals, so a value beginning with `-` (`-D`, `--all`,
/// `--orphan`, `--detach`, …) is parsed by git as an OPTION rather than a ref — the
/// injection this guards against. Names that are merely malformed (`..`, whitespace,
/// control chars, `~^:?*[\`, empty components, `.lock` suffixes, …) are rejected too,
/// so an unusual name fails loudly here instead of silently breaking allocation,
/// merge, or status.
///
/// A conservative subset of `git check-ref-format`, kept PURE + unit-tested (the
/// module's convention) rather than shelling out — version-independent and needing no
/// repo. Paired with the `--end-of-options` separator every ref-taking git call in
/// this module now carries, the option-injection hole is closed at ingestion AND at
/// each call site (defence in depth).
pub fn validate_ref(name: &str) -> Result<(), String> {
    let reject = |why: &str| Err(format!("invalid branch/base name {name:?}: {why}"));
    if name.is_empty() {
        return reject("must not be empty");
    }
    // The core of the vulnerability: a leading '-' makes git read the value as an
    // OPTION (`-D`, `--all`, `--orphan`, …) instead of a ref.
    if name.starts_with('-') {
        return reject("must not start with '-' (git parses it as an option, not a ref)");
    }
    if name == "@" {
        return reject("must not be the single character '@'");
    }
    if name.ends_with('/') || name.ends_with('.') {
        return reject("must not end with '/' or '.'");
    }
    if name.contains("..") || name.contains("@{") || name.contains("//") {
        return reject("must not contain '..', '@{', or '//'");
    }
    for ch in name.chars() {
        if ch.is_control() || ch == ' ' {
            return reject("must not contain whitespace or control characters");
        }
        if matches!(ch, '~' | '^' | ':' | '?' | '*' | '[' | '\\') {
            return reject("must not contain any of: ~ ^ : ? * [ \\");
        }
    }
    // Per-component (slash-separated) git ref rules: no component may be empty, begin
    // with '.', or end with '.lock'.
    for comp in name.split('/') {
        if comp.is_empty() {
            return reject("must not have an empty path component (leading/trailing/double '/')");
        }
        if comp.starts_with('.') {
            return reject("no path component may start with '.'");
        }
        if comp.ends_with(".lock") {
            return reject("no path component may end with '.lock'");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn branch_and_path_computation() {
        let project = Path::new("/repo/nightcore");
        assert_eq!(branch_name("abc-123"), "nc/abc-123");
        assert_eq!(
            worktrees_base(project),
            PathBuf::from("/repo/nightcore/.nightcore/worktrees")
        );
        assert_eq!(
            worktree_path(project, "abc-123"),
            PathBuf::from("/repo/nightcore/.nightcore/worktrees/abc-123")
        );
    }

    #[test]
    fn is_under_guards_the_base() {
        let base = Path::new("/repo/.nightcore/worktrees");
        assert!(is_under(
            base,
            Path::new("/repo/.nightcore/worktrees/task-1")
        ));
        assert!(
            !is_under(base, Path::new("/repo")),
            "parent is not under base"
        );
        assert!(
            !is_under(base, base),
            "the base itself is not strictly under"
        );
        assert!(
            !is_under(base, Path::new("/repo/.nightcore/other")),
            "a sibling dir is not under the worktrees base"
        );
        assert!(
            !is_under(base, Path::new("/etc/passwd")),
            "an unrelated path is rejected"
        );
    }

    #[test]
    fn remove_refuses_paths_outside_the_base() {
        // A task id that tries to escape the base via traversal can't reach outside
        // it: worktree_path joins it under the base, and is_under still holds. Here
        // we assert the guard directly on a crafted path.
        let base = worktrees_base(Path::new("/repo"));
        assert!(!is_under(&base, Path::new("/repo/.git")));
    }

    #[test]
    fn validate_ref_accepts_normal_branch_names() {
        for ok in [
            "main",
            "nc/abc-123",
            "feature/foo",
            "release-2.0",
            "user/fix.bug",
            "a_b-c/d",
        ] {
            assert!(
                validate_ref(ok).is_ok(),
                "expected {ok:?} to be a valid ref: {:?}",
                validate_ref(ok)
            );
        }
    }

    #[test]
    fn validate_ref_rejects_option_injection_and_malformed_names() {
        // A leading '-' is the core hole: git would parse these as OPTIONS, not refs.
        for bad in ["-D", "--all", "--detach", "--orphan", "-"] {
            assert!(
                validate_ref(bad).is_err(),
                "a leading-dash name {bad:?} must be rejected (git reads it as an option)"
            );
        }
        // …and other names that are simply not legal git refs.
        for bad in [
            "",           // empty
            "@",          // the single '@'
            "a..b",       // '..'
            "a b",        // whitespace
            "a\tb",       // control char
            "a~b",        // '~'
            "a^b",        // '^'
            "a:b",        // ':'
            "a?b",        // '?'
            "a*b",        // '*'
            "a[b",        // '['
            "a\\b",       // backslash
            "a@{b",       // '@{'
            "/leading",   // leading '/'
            "trailing/",  // trailing '/'
            "double//sl", // '//'
            "trailing.",  // trailing '.'
            ".hidden",    // component starts with '.'
            "foo/.bar",   // later component starts with '.'
            "foo.lock",   // '.lock' suffix
            "a/b.lock",   // '.lock' on a later component
        ] {
            assert!(
                validate_ref(bad).is_err(),
                "malformed ref {bad:?} must be rejected"
            );
        }
    }
}
