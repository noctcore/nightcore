//! Shared canonicalized symlink-walk containment core (issue #178).
//!
//! Two security-critical call sites resolve an untrusted, repo-relative path against a
//! trusted root and must prove it cannot escape via a symlink. They previously
//! re-implemented the identical walk; this module is the single home for it:
//!
//!  * the WRITE path — [`crate::sidecar::harness::apply::safe_join`] composes this core
//!    UNDER an execution-sink denylist. A synthesized harness artifact must never LAND a
//!    `.github/workflows/*.yml`, `.claude/settings.json`, `package.json`, … that would
//!    auto-execute on the next agent run, so that denylist is layered on top of the core.
//!  * the READ path — [`crate::worktree::diff::confined_untracked_path`] composes this
//!    core ALONE. Viewing a diff of a legitimate `.github/…`/`agents.md` file is safe, so
//!    the write-only denylist must NOT apply here.
//!
//! This core therefore deliberately carries NO denylist — that layer belongs to the write
//! path only. Extracting it here resolves the standing `TODO(#178)` in `diff.rs`.
//!
//! The guarantee: walk the joined path component-by-component with `symlink_metadata`
//! (lstat, which does NOT follow links — unlike `exists()`), rejecting ANY existing
//! component that is a symlink. This is the real escape guard. A DANGLING leaf symlink
//! (an untrusted repo shipping `AGENTS.md -> /outside`) reports `exists() == false`, so a
//! naive ancestor walk skips past it and a later `fs::read`/`fs::write` follows it OUT of
//! the root; lstat sees the link itself. An in-root symlink (`AGENTS.md -> src/main.rs`)
//! is rejected too, so a write can't corrupt an unrelated file and a read can't be
//! redirected to one. Finally, the resolved path must still sit under the canonical root.
//!
//! Callers MUST have already lexically rejected `..`/absolute/root components: this walk
//! SKIPS non-`Normal` components rather than rejecting them (only a `.` can reach here
//! once the caller's lexical layer has run — `safe_join`'s component match, or `diff`'s
//! `sanitize_diff_path`). The `..` guard is the caller's, not this core's.

use std::path::{Component, Path, PathBuf};

/// A path proven to resolve INSIDE a canonical root with no symlink anywhere in its chain.
pub(crate) struct Confined {
    /// The canonicalized root (`root.canonicalize()`) — reused by callers that build a
    /// destination path off it (the write path re-joins the original relative path to it).
    pub root: PathBuf,
    /// The resolved absolute path (`root` + the walked `Normal` components), guaranteed
    /// contained in `root` with no symlink in the chain.
    pub path: PathBuf,
}

/// Canonicalize `root`, walk `rel` with per-component lstat symlink rejection, and assert
/// the result is contained in the canonical root. `subject` and `container` name the path
/// and its root in the returned error strings so each call site reads faithfully
/// (`"artifact path"` / `"project root"` for the write path, `"diff path"` / `"worktree"`
/// for the read path); they affect ONLY message text, never the containment logic.
///
/// SECURITY: this is the shared escape guard — see the module docs. It performs NO
/// execution-sink denylisting; the write path layers that on top BEFORE calling here.
pub(crate) fn confine(
    root: &Path,
    rel: &str,
    subject: &str,
    container: &str,
) -> Result<Confined, String> {
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("{container} {} is not accessible: {e}", root.display()))?;

    // Walk from the canonical root, pushing each Normal component and lstat-ing it. lstat
    // (`symlink_metadata`) does NOT follow links, so a dangling OR live symlink component
    // is caught HERE rather than followed by a later read/write syscall. Non-Normal
    // components carry nothing to follow (only `.` can reach here — callers reject
    // `..`/absolute lexically) and are skipped.
    let mut current = root_canon.clone();
    for comp in Path::new(rel).components() {
        let Component::Normal(name) = comp else {
            continue;
        };
        current.push(name);
        if let Ok(meta) = std::fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "{subject} passes through a symlink (rejected): {rel}"
                ));
            }
        }
    }

    // Defence in depth: with no symlink in the chain and no `..`, `current` is inside the
    // root by construction — assert it anyway.
    if current != root_canon && !current.starts_with(&root_canon) {
        return Err(format!("{subject} resolves outside the {container}: {rel}"));
    }

    Ok(Confined {
        root: root_canon,
        path: current,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // The read-path labels are used throughout so the messages read like the diff site;
    // the labels are message-only, so any pair proves the same containment logic.
    const SUBJECT: &str = "diff path";
    const CONTAINER: &str = "worktree";

    #[test]
    fn confine_accepts_a_repo_relative_path() {
        let tmp = TempDir::new().unwrap();
        let out = confine(
            tmp.path(),
            "packages/eslint-plugin/index.ts",
            SUBJECT,
            CONTAINER,
        )
        .unwrap();
        assert_eq!(out.root, tmp.path().canonicalize().unwrap());
        assert!(out.path.starts_with(tmp.path().canonicalize().unwrap()));
        assert!(out.path.ends_with("packages/eslint-plugin/index.ts"));
    }

    #[test]
    fn confine_has_no_execution_sink_denylist() {
        // The whole point of the split (issue #178): the containment CORE must ALLOW every
        // path the write-path denylist rejects — `.github/workflows/*`, `.claude/*`,
        // `package.json`, … — because READING a diff of such a file is safe. The
        // execution-sink denylist is layered ONLY by `safe_join` (the write path).
        let tmp = TempDir::new().unwrap();
        for ok in [
            ".github/workflows/ci.yml",
            ".claude/settings.local.json",
            ".vscode/tasks.json",
            "package.json",
            "Makefile",
            ".husky/pre-commit",
            "sub/.envrc",
        ] {
            assert!(
                confine(tmp.path(), ok, SUBJECT, CONTAINER).is_ok(),
                "the containment core carries no denylist and must allow {ok:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn confine_rejects_a_symlinked_dir_escape() {
        // A symlinked directory inside the root pointing outside must not let the walk
        // resolve through it.
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        assert!(confine(root.path(), "link/escape.ts", SUBJECT, CONTAINER).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn confine_rejects_a_dangling_leaf_symlink() {
        // A DANGLING leaf reports exists()==false, so a naive ancestor walk skips past it;
        // lstat must still catch the link itself.
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap().path().join("evil-not-yet-created");
        std::os::unix::fs::symlink(&outside, root.path().join("notes.txt")).unwrap();
        assert!(
            !root.path().join("notes.txt").exists(),
            "precondition: the symlink is dangling (target absent)"
        );
        assert!(confine(root.path(), "notes.txt", SUBJECT, CONTAINER).is_err());
        assert!(!outside.exists(), "nothing resolved outside the root");
    }

    #[cfg(unix)]
    #[test]
    fn confine_rejects_an_in_root_symlink_leaf() {
        // An IN-ROOT symlink leaf (`link.rs -> src/main.rs`) passes canonical containment
        // but must be rejected so a write can't corrupt — and a read can't be redirected
        // to — an unrelated in-repo file.
        let root = TempDir::new().unwrap();
        std::fs::create_dir_all(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("src/main.rs"), "fn main() {}").unwrap();
        std::os::unix::fs::symlink(root.path().join("src/main.rs"), root.path().join("link.rs"))
            .unwrap();
        assert!(confine(root.path(), "link.rs", SUBJECT, CONTAINER).is_err());
    }
}
