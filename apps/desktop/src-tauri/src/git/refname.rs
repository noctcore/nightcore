//! Git ref-name validation — a pure, version-independent git primitive.
//!
//! Lives in `git` (rank 2) so every tier that splices a user-supplied ref into a
//! `git`/`gh` argument list can depend DOWNWARD on it. Hoisted here from
//! `worktree::path` (issue #17 phase A.3): a ref validator belongs with the git
//! primitives, not the worktree leaf, and `store` (rank 3) was reaching sideways
//! into `worktree` (rank 3) for it.

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
/// A conservative subset of `git check-ref-format`, kept PURE + unit-tested rather
/// than shelling out — version-independent and needing no repo. Paired with the
/// `--end-of-options` separator every ref-taking git call carries, the
/// option-injection hole is closed at ingestion AND at each call site (defence in
/// depth).
pub(crate) fn validate_ref(name: &str) -> Result<(), String> {
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
