//! `safe_join` — the security-critical WRITE-path container for harness artifacts.
//!
//! Resolves an untrusted, repo-relative artifact path against a trusted project root
//! and proves it cannot escape: lexical `..`/absolute rejection → execution-sink
//! denylist → the shared canonicalized symlink-walk containment core
//! ([`crate::infra::path_confine::confine`]) → a deepest-existing-ancestor check.
//!
//! Hoisted out of `sidecar/harness/apply.rs` into `infra/` (issue #178) so this one
//! tested container is the single shared home BEFORE a second agent-file writer can
//! copy-paste it — a duplicated path validator is the classic way a later fix lands on
//! one copy while the other silently keeps the hole. The harness file-write path
//! (`sidecar::harness::apply`) and the RuleTester runner both call it here. The
//! execution-sink denylist it layers on top of the containment core is WRITE-path-only
//! (the read path — `worktree::diff` — composes `path_confine::confine` alone). Do not
//! weaken, reorder, or "tidy" any check here.

use std::path::{Component, Path, PathBuf};

/// In-repo execution sinks: directories whose contents run AUTOMATICALLY (CI
/// pipelines, git hooks, editor/agent config). Containing a write to the repo root
/// is not enough — the harness synthesis pass reads (possibly untrusted) target-repo
/// content, so a prompt-injected proposal could land a brand-new `.github/workflows/*.yml`
/// (a YAML file needs no execute bit), a `.claude/settings.local.json` whose hooks run
/// arbitrary shell on the very next agent run, or a `.vscode/tasks.json` that auto-runs
/// on folder open — each one-click-applied and then executed with NO further click.
/// These are NEVER legitimate harness artifacts (which are docs + lint config), so any
/// target inside one is rejected. Matched case-INSENSITIVELY: a case-insensitive
/// filesystem (the macOS default) would otherwise let `.GitHub/workflows/…` resolve to
/// the real path.
const DENIED_TARGET_PREFIXES: &[&str] = &[
    ".git/",              // all git internals, incl. .git/hooks/
    ".github/workflows/", // GitHub Actions
    ".husky/",            // Husky-managed git hooks
    ".circleci/",         // CircleCI
    ".claude/", // Claude Code settings/hooks — run arbitrary shell; loaded on the next agent run
    ".vscode/", // VS Code tasks.json / launch.json — auto-run on folder open / debug
];
/// Execution-sink FILE BASENAMES: rejected wherever they sit in the tree (matched on the
/// last path component, not just the repo root), because their trigger is the file name —
/// a nested `package.json` still fires npm/bun lifecycle scripts, `make`/direnv/pre-commit
/// read by basename anywhere. A denylist can never be exhaustive, so `merge-section` (the
/// only mode that touches a PRE-EXISTING file) is additionally allowlisted to agent docs
/// below; for `create`, this basename set covers the highest-value auto-exec sinks. Lower
/// case (matched case-insensitively).
const DENIED_TARGET_BASENAMES: &[&str] = &[
    "package.json", // npm/bun/yarn preinstall/postinstall/prepare lifecycle scripts
    "makefile",     // `make` recipe bodies
    "gnumakefile",  // GNU make's higher-priority makefile name
    ".envrc",       // direnv — auto-exec on cd into the dir
    ".pre-commit-config.yaml", // pre-commit — runs hook commands on every commit
    ".gitlab-ci.yml", // GitLab CI
    ".gitlab-ci.yaml",
    // lefthook — its recipe bodies run as git hooks once `lefthook install` has wired
    // the repo, and dropping a config re-arms an already-wired one. Same class as
    // `.pre-commit-config.yaml`; commit-discipline output (hardening module #18) must
    // route through a human-reviewed agent task instead. All names lefthook resolves.
    "lefthook.yml",
    ".lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yaml",
    "lefthook.toml",
    ".lefthook.toml",
    "lefthook.json",
    ".lefthook.json",
    // devcontainer config — postCreateCommand/onCreateCommand execute on container
    // create/attach, so the sandbox module (#15) must route devcontainers through a
    // human-reviewed agent task; a synthesized artifact can never write one. Covers the
    // canonical `.devcontainer/devcontainer.json` (basename matches at any depth) and
    // the root `.devcontainer.json` dot-form.
    "devcontainer.json",
    ".devcontainer.json",
];

/// Resolve a repo-relative artifact path against `root`, rejecting anything that could
/// escape the project OR land in an auto-executing sink. Defence in layers:
///  1. lexical: reject empty / absolute / any `..` or root/prefix component, so the join
///     can't climb out before we ever touch the filesystem;
///  2. execution-sink denylist (WRITE-path only): reject targets inside CI / git-hook /
///     editor-config dirs and auto-exec basenames (see `DENIED_TARGET_*`) — a synthesized
///     artifact must never LAND a file that runs on the next agent run;
///  3. containment core: the shared canonicalized symlink-walk
///     ([`crate::infra::path_confine::confine`]) — reject any symlink in the path (defeats
///     a symlinked directory/leaf the lexical check can't see) and assert canonical
///     containment. This is the SAME guard the read path uses;
///  4. defence in depth: the deepest EXISTING ancestor of the destination must still
///     canonicalize to inside the canonical project root.
///
/// Layer 3 is the read path's ENTIRE guard ([`crate::worktree::diff`]); layers 2 + 4 are
/// write-path-specific. Returns the absolute destination path (which may not exist yet,
/// for `create`).
pub(crate) fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("artifact target path is empty".to_string());
    }
    let rel_path = Path::new(rel);
    for comp in rel_path.components() {
        match comp {
            Component::Normal(_) => {}
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("artifact path escapes the project (`..`): {rel}"))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "artifact path must be repo-relative, not absolute: {rel}"
                ))
            }
        }
    }

    // Execution-sink denylist: reject targets inside CI / git-hook directories even
    // though they are repo-relative and non-symlinked, because their contents run
    // automatically once applied. Normalize to a lowercase `/`-joined string from the
    // NORMAL components only (drops `./`), so `./.GitHub/Workflows/x.yml` is caught.
    let normalized = rel_path
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if let Some(prefix) = DENIED_TARGET_PREFIXES
        .iter()
        .find(|p| normalized.starts_with(**p))
    {
        return Err(format!(
            "artifact path targets a protected execution sink ({prefix}): {rel}"
        ));
    }
    // Basename match: reject the sink wherever it sits in the tree, not only at the root.
    let basename = normalized.rsplit('/').next().unwrap_or("");
    if DENIED_TARGET_BASENAMES.contains(&basename) {
        return Err(format!(
            "artifact path targets a protected execution sink ({basename}): {rel}"
        ));
    }

    // Shared symlink-walk containment core (issue #178): canonicalize the root, walk the
    // path component-by-component rejecting ANY existing symlink (dangling or live — the
    // real escape guard, since lstat sees the link where `exists()` would follow it), and
    // assert canonical containment. This is the SAME guard the READ path
    // (`worktree::diff::confined_untracked_path`) uses; the execution-sink denylist above
    // is the WRITE-path-only layer that must NOT reject a read of a legitimate file.
    let root_canon =
        crate::infra::path_confine::confine(root, rel, "artifact path", "project root")?.root;
    let dest = root_canon.join(rel_path);

    // Defence in depth: the deepest existing ancestor must still canonicalize to
    // inside the root (catches any non-symlink escape the lexical check missed). With
    // no symlink in the chain (rejected above), this can only differ from the lexical
    // `dest` if the root itself moved — still safe to assert.
    let mut probe = dest.as_path();
    let existing = loop {
        if std::fs::symlink_metadata(probe).is_ok() {
            break probe
                .canonicalize()
                .map_err(|e| format!("cannot resolve {}: {e}", probe.display()))?;
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => return Err("artifact path has no resolvable ancestor".to_string()),
        }
    };
    if existing != root_canon && !existing.starts_with(&root_canon) {
        return Err(format!(
            "artifact path resolves outside the project root: {rel}"
        ));
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn safe_join_accepts_a_repo_relative_path() {
        let tmp = TempDir::new().unwrap();
        let dest = safe_join(tmp.path(), "packages/eslint-plugin/index.ts").unwrap();
        assert!(dest.starts_with(tmp.path().canonicalize().unwrap()));
        assert!(dest.ends_with("packages/eslint-plugin/index.ts"));
    }

    #[test]
    fn safe_join_rejects_parent_escape() {
        let tmp = TempDir::new().unwrap();
        for bad in ["../escape.ts", "a/../../escape.ts", "../../etc/passwd"] {
            assert!(
                safe_join(tmp.path(), bad).is_err(),
                "must reject traversal {bad:?}"
            );
        }
    }

    #[test]
    fn safe_join_rejects_absolute_path() {
        let tmp = TempDir::new().unwrap();
        for bad in ["/etc/passwd", "/tmp/x.ts"] {
            assert!(
                safe_join(tmp.path(), bad).is_err(),
                "must reject absolute {bad:?}"
            );
        }
    }

    #[test]
    fn safe_join_rejects_symlink_escape() {
        // A symlinked dir inside the repo pointing outside must not let a write escape.
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let link = root.path().join("link");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
            let result = safe_join(root.path(), "link/escape.ts");
            assert!(
                result.is_err(),
                "symlinked dir escaping the root must be rejected"
            );
        }
        #[cfg(not(unix))]
        {
            let _ = (link, outside);
        }
    }

    #[cfg(unix)]
    #[test]
    fn safe_join_rejects_dangling_leaf_symlink() {
        // The reviewer's HIGH finding: a DANGLING symlink at the leaf (target absent)
        // reports exists()==false, so a naive ancestor walk skips past it and a later
        // merge-section `fs::write` follows it OUT of the project root. lstat must catch
        // the link itself and reject the path. `AGENTS.md`/`CLAUDE.md` are the realistic
        // targets (agent-contract artifacts use merge-section).
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap().path().join("evil-not-yet-created");
        std::os::unix::fs::symlink(&outside, root.path().join("AGENTS.md")).unwrap();
        assert!(
            !root.path().join("AGENTS.md").exists(),
            "precondition: the symlink is dangling (target does not exist)"
        );
        assert!(
            safe_join(root.path(), "AGENTS.md").is_err(),
            "a dangling-leaf symlink must be rejected, not followed out of the root"
        );
        assert!(
            !outside.exists(),
            "nothing must have been written outside the root"
        );
    }

    #[cfg(unix)]
    #[test]
    fn safe_join_rejects_in_root_symlink_leaf() {
        // An IN-ROOT symlink leaf (AGENTS.md -> src/main.rs) passes canonical containment
        // but a merge would corrupt an unrelated repo file. lstat rejects it.
        let root = TempDir::new().unwrap();
        std::fs::create_dir_all(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("src/main.rs"), "fn main() {}").unwrap();
        std::os::unix::fs::symlink(
            root.path().join("src/main.rs"),
            root.path().join("AGENTS.md"),
        )
        .unwrap();
        assert!(
            safe_join(root.path(), "AGENTS.md").is_err(),
            "an in-root symlink leaf must be rejected so a merge can't corrupt another file"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("src/main.rs")).unwrap(),
            "fn main() {}",
            "the symlink target file is untouched"
        );
    }

    #[test]
    fn safe_join_rejects_execution_sinks() {
        let tmp = TempDir::new().unwrap();
        for bad in [
            ".github/workflows/evil.yml",
            ".git/hooks/pre-commit",
            ".git/config",
            ".husky/pre-commit",
            ".circleci/config.yml",
            ".gitlab-ci.yml",
            // case-insensitive-filesystem bypass attempt must also be rejected
            ".GitHub/Workflows/evil.yml",
            "./.github/workflows/evil.yml",
            // Auto-loaded editor/agent config sinks (one-click apply → code execution
            // on the next agent run / folder open, no execute bit needed).
            ".claude/settings.json",
            ".claude/settings.local.json",
            ".vscode/tasks.json",
            ".vscode/launch.json",
            "./.Claude/Settings.local.json", // case-insensitive bypass attempt
            // Basename sinks are rejected wherever they sit in the tree, not only at root.
            "package.json",
            "apps/web/package.json",
            "deeply/nested/pkg/package.json",
            "Makefile",
            "tools/Makefile",
            "GNUmakefile",
            ".envrc",
            "sub/.envrc",
            ".pre-commit-config.yaml",
            ".GitLab-CI.yml", // case-insensitive basename bypass attempt
            // lefthook configs are git-hook bodies once installed — rejected at any
            // depth and in every format/dotted variant lefthook resolves.
            "lefthook.yml",
            ".lefthook.yaml",
            "tools/lefthook.toml",
            "packages/web/Lefthook.json", // case-insensitive basename bypass attempt
            // devcontainer configs execute postCreate hooks on container create — the
            // sandbox module (#15) must never land one as an artifact, at any depth,
            // in either name form, case-insensitively.
            ".devcontainer/devcontainer.json",
            ".devcontainer.json",
            "apps/web/.devcontainer/devcontainer.json",
            ".devcontainer/DevContainer.json", // case-insensitive bypass attempt
        ] {
            assert!(
                safe_join(tmp.path(), bad).is_err(),
                "must reject execution sink {bad:?}"
            );
        }
    }

    #[test]
    fn safe_join_allows_non_sink_paths_that_merely_resemble_sinks() {
        // Precision guard: the denylist must NOT over-block legitimate source dirs
        // (a React `hooks/` dir) or non-executable `.github/` content (issue templates),
        // nor a source dir/file whose NAME merely contains a sink substring.
        let tmp = TempDir::new().unwrap();
        for ok in [
            "apps/web/src/hooks/useThing.ts",
            ".github/ISSUE_TEMPLATE/bug.md",
            ".github/CODEOWNERS",
            "packages/eslint-plugin/src/index.ts",
            // Legitimate harness output the fix must keep allowing.
            "CLAUDE.md",
            "AGENTS.md",
            "eslint.config.js",
            "packages/eslint-plugin/rules/no-cross-feature-imports.js",
            "packages/eslint-plugin/README.md",
            // Names that merely resemble a sink but aren't one.
            "packages/vscode-extension/src/index.ts", // dir contains "vscode", not `.vscode/`
            "packages/claude-helpers/index.ts",       // dir contains "claude", not `.claude/`
            "docs/package-json-guide.md",             // basename is NOT `package.json`
            "src/makefile-parser.ts",                 // basename is NOT `makefile`
            "docs/devcontainer-setup.md",             // basename is NOT `devcontainer.json`
            "sandbox/agent.sb",                       // module #15's inert Seatbelt profile
        ] {
            assert!(
                safe_join(tmp.path(), ok).is_ok(),
                "must allow non-sink path {ok:?}"
            );
        }
    }

    #[test]
    fn write_path_denies_a_dotfile_the_read_path_core_allows() {
        // Issue #178 divergence, proven at the write site. `safe_join` (containment core +
        // execution-sink denylist) REJECTS a `.github/workflows/*.yml` target so a
        // synthesized artifact can never LAND an auto-executing workflow file. The shared
        // containment CORE alone — exactly what the read path (`worktree::diff`) uses —
        // ALLOWS the same path, because viewing a diff of a legit workflow file is safe.
        // The denylist is a WRITE-path-only layer, NOT part of the core.
        let tmp = TempDir::new().unwrap();
        assert!(
            safe_join(tmp.path(), ".github/workflows/x.yml").is_err(),
            "the write path denies a workflow-file target"
        );
        assert!(
            crate::infra::path_confine::confine(
                tmp.path(),
                ".github/workflows/x.yml",
                "diff path",
                "worktree",
            )
            .is_ok(),
            "the read-path core allows the same path (no denylist)"
        );
    }
}
