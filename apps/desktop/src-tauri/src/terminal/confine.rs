//! OPT-IN macOS write-containment for a CONFINED user terminal (decision 1).
//!
//! Mirrors the engine's Seatbelt write-sandbox (`providers/claude/sandbox.ts`) but
//! for a Rust-spawned shell: a `(allow default)` + `(deny file-write*)` profile
//! with `file-write*` re-allowed only under the session cwd (plus the git common
//! dir for a worktree cwd, `/dev`, and the temp trees so an ordinary shell still
//! works). Reads and network stay open — this contains WRITES to the workspace, it
//! does not air-gap.
//!
//! **FAIL CLOSED** — unlike the engine's fail-OPEN sandbox (an experimental,
//! default-off agent feature that must never strand a task), a user who explicitly
//! ticked "Confined" is asking for containment: if the profile can't be assembled
//! (not macOS, no `sandbox-exec`, cwd won't canonicalize, scratch write fails) we
//! REFUSE the spawn with an error rather than silently launching an unconfined
//! shell. The default terminal is unconfined; confinement is the deliberate ask.
//!
//! The profile string builder and the git-common-dir parser are PURE (no macOS,
//! no I/O beyond the `.git` read) so they unit-test on any host; only [`prepare`]
//! touches Seatbelt and the filesystem, and is macOS-only.

use std::path::{Path, PathBuf};

/// The Seatbelt interpreter — an absolute, SIP-protected path, never resolved via
/// PATH (so a malicious `sandbox-exec` shim can't intercept the wrap).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// What [`prepare`] hands back: the program + prefix args to launch INSTEAD of the
/// bare shell. The caller appends the shell + its args, so the final argv is
/// `sandbox-exec -f <profile> <shell> -i`.
#[derive(Debug, Clone)]
pub(crate) struct ConfinedLaunch {
    pub(crate) program: PathBuf,
    pub(crate) prefix_args: Vec<String>,
}

/// Escape a path for a Seatbelt TinyScheme double-quoted string literal.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn seatbelt_string(p: &str) -> String {
    format!("\"{}\"", p.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Build a deny-write-except profile: everything allowed except `file-write*`,
/// re-allowed only under each root (`subpath` — the root and everything beneath).
/// Pure — no I/O — so it is unit-testable off a macOS host. Callers must pass
/// CANONICALIZED roots (Seatbelt matches the kernel-resolved, symlink-free path).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn build_profile(writable_roots: &[String]) -> String {
    let mut lines = vec![
        "(version 1)".to_string(),
        "(allow default)".to_string(),
        "(deny file-write*)".to_string(),
    ];
    for root in writable_roots {
        lines.push(format!(
            "(allow file-write* (subpath {}))",
            seatbelt_string(root)
        ));
    }
    lines.join("\n") + "\n"
}

/// When `cwd` is a LINKED git worktree, its `.git` is a FILE containing
/// `gitdir: <abs>/.git/worktrees/<name>`; git writes index/locks/objects/refs to
/// that common dir even for worktree-local ops, so containment must allow the whole
/// `<repo>/.git` or every `git` command in the terminal fails. Returns `None` for a
/// normal checkout (its `.git` is a dir under cwd) or a non-repo cwd. The parent
/// WORKING TREE is deliberately NOT allowed. Pure but for the `.git` file read.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn git_common_write_root(cwd: &Path) -> Option<PathBuf> {
    let dot_git = cwd.join(".git");
    if !dot_git.is_file() {
        return None; // a normal checkout's `.git` is a directory, already under cwd
    }
    let content = std::fs::read_to_string(&dot_git).ok()?;
    let gitdir_line = content
        .lines()
        .find_map(|l| l.strip_prefix("gitdir:"))?
        .trim();
    let gitdir = cwd.join(gitdir_line);
    // `<repo>/.git/worktrees/<name>` → allow `<repo>/.git`. Any other layout: allow
    // the pointed-to dir itself.
    let worktrees_dir = gitdir.parent()?;
    let common = if worktrees_dir.file_name().is_some_and(|n| n == "worktrees") {
        worktrees_dir.parent()?.to_path_buf()
    } else {
        gitdir
    };
    Some(common)
}

/// `canonicalize` that degrades to the lexical absolute path when the target can't
/// be resolved — a not-yet-created optional root still gets a rule.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn realpath_or(p: &Path) -> String {
    std::fs::canonicalize(p)
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// The writable roots for one confined session: the (canonicalized) cwd, the git
/// common dir for a worktree cwd, `/dev`, and the darwin temp trees. Deduped,
/// order-stable. Returns an error only if the cwd itself can't be canonicalized
/// (fail-closed: a session with no writable cwd is useless and the ask was for
/// containment).
#[cfg(target_os = "macos")]
fn derive_writable_roots(cwd: &Path) -> Result<Vec<String>, String> {
    let mut roots = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut add = |p: String| {
        if seen.insert(p.clone()) {
            roots.push(p);
        }
    };

    let canon_cwd = std::fs::canonicalize(cwd).map_err(|e| {
        format!(
            "confined terminal: cwd {} cannot be resolved: {e}",
            cwd.display()
        )
    })?;
    add(canon_cwd.to_string_lossy().into_owned());
    if let Some(git_common) = git_common_write_root(cwd) {
        add(realpath_or(&git_common));
    }
    add("/dev".to_string());
    add(realpath_or(&std::env::temp_dir()));
    add("/private/tmp".to_string());
    add("/private/var/folders".to_string());
    Ok(roots)
}

/// Assemble the confinement wrapper for a shell about to run in `cwd`. FAIL CLOSED:
/// any failure returns an error and the caller must NOT spawn unconfined.
#[cfg(target_os = "macos")]
pub(crate) fn prepare(cwd: &Path) -> Result<ConfinedLaunch, String> {
    if !Path::new(SANDBOX_EXEC).exists() {
        return Err(format!(
            "confined terminal unavailable: {SANDBOX_EXEC} is missing on this host"
        ));
    }
    let roots = derive_writable_roots(cwd)?;
    let profile = build_profile(&roots);

    // A per-session scratch dir under the temp tree (which is itself a writable
    // root — the profile is read once at exec, so a running session can't rewrite
    // its own containment). Unique via pid + nanos, matching `store::atomic`.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let scratch = std::env::temp_dir().join(format!(
        "nightcore-term-sandbox-{}-{nonce}",
        std::process::id()
    ));
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("confined terminal: cannot create sandbox scratch dir: {e}"))?;
    let profile_path = scratch.join("write-containment.sb");
    std::fs::write(&profile_path, profile)
        .map_err(|e| format!("confined terminal: cannot write Seatbelt profile: {e}"))?;

    Ok(ConfinedLaunch {
        program: PathBuf::from(SANDBOX_EXEC),
        prefix_args: vec![
            "-f".to_string(),
            profile_path.to_string_lossy().into_owned(),
        ],
    })
}

/// Non-macOS: confinement is a macOS-only Seatbelt feature. Fail closed.
#[cfg(not(target_os = "macos"))]
pub(crate) fn prepare(_cwd: &Path) -> Result<ConfinedLaunch, String> {
    Err("confined terminals require macOS Seatbelt (sandbox-exec)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn profile_denies_writes_then_allows_each_root() {
        let profile = build_profile(&["/work/dir".to_string(), "/private/tmp".to_string()]);
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("(allow file-write* (subpath \"/work/dir\"))"));
        assert!(profile.contains("(allow file-write* (subpath \"/private/tmp\"))"));
        // The deny must precede the allows (first the blanket deny, then carve-outs).
        let deny = profile.find("(deny file-write*)").unwrap();
        let allow = profile.find("(allow file-write* (subpath").unwrap();
        assert!(
            deny < allow,
            "the blanket deny comes before the allow carve-outs"
        );
    }

    #[test]
    fn seatbelt_string_escapes_quotes_and_backslashes() {
        assert_eq!(seatbelt_string(r#"/a "b"\c"#), r#""/a \"b\"\\c""#);
    }

    #[test]
    fn git_common_root_is_none_for_a_normal_checkout() {
        // A `.git` DIRECTORY (normal checkout) yields no extra root — it's under cwd.
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        assert!(git_common_write_root(tmp.path()).is_none());
    }

    #[test]
    fn git_common_root_resolves_a_linked_worktree() {
        // A `.git` FILE with a `gitdir:` pointer (linked worktree) yields the repo's
        // `.git` common dir so `git` works inside the confined worktree terminal.
        let tmp = TempDir::new().unwrap();
        let repo_git = tmp.path().join("repo/.git");
        std::fs::create_dir_all(repo_git.join("worktrees/wt1")).unwrap();
        let wt = tmp.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", repo_git.join("worktrees/wt1").display()),
        )
        .unwrap();
        assert_eq!(git_common_write_root(&wt), Some(repo_git));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn prepare_fails_closed_off_macos() {
        let err = prepare(Path::new("/tmp")).unwrap_err();
        assert!(
            err.contains("macOS"),
            "off-macOS confinement must refuse: {err}"
        );
    }
}
