//! The security-critical applyable file-write path for Harness artifacts.
//!
//! `apply_harness_artifact` (in `commands.rs`) is the only command that mutates a user's
//! files; everything that decides WHERE and HOW that write lands lives here. The
//! destination must resolve inside the project root ([`safe_join`] — lexical `..`/absolute
//! rejection THEN a canonicalized containment check that also defeats symlink escapes),
//! `create` never clobbers an existing file ([`write_create`] via `create_new`), and doc
//! artifacts merge into a delimited managed block ([`write_merge_section`] →
//! [`merge_managed_section`], atomic temp file + rename). Do not weaken, reorder, or
//! "tidy" any check here.

use std::io::Write as _;
use std::path::{Component, Path, PathBuf};

/// The delimiters bounding the managed block a `merge-section` artifact owns inside a
/// CLAUDE.md / AGENTS.md. Re-applying replaces only the block between these markers, so
/// the user's surrounding hand-written content is never touched.
const SECTION_START: &str = "<!-- nightcore:harness:start -->";
const SECTION_END: &str = "<!-- nightcore:harness:end -->";

/// In-repo execution sinks: directories whose contents run AUTOMATICALLY (CI
/// pipelines, git hooks). Containing a write to the repo root is not enough — the
/// harness synthesis pass reads (possibly untrusted) target-repo content, so a
/// prompt-injected proposal could land a brand-new `.github/workflows/*.yml` (a
/// YAML file needs no execute bit) or a git hook that the user one-click-applies
/// and that then executes on the next push/commit. These are NEVER legitimate
/// harness artifacts (which are docs + lint config), so any target inside one is
/// rejected. Matched case-INSENSITIVELY: a case-insensitive filesystem (the macOS
/// default) would otherwise let `.GitHub/workflows/…` resolve to the real path.
const DENIED_TARGET_PREFIXES: &[&str] = &[
    ".git/",              // all git internals, incl. .git/hooks/
    ".github/workflows/", // GitHub Actions
    ".husky/",            // Husky-managed git hooks
    ".circleci/",         // CircleCI
];
/// Single-file execution sinks (no trailing-slash prefix to match).
const DENIED_TARGET_FILES: &[&str] = &[".gitlab-ci.yml", ".gitlab-ci.yaml"];

/// Resolve a repo-relative artifact path against `root`, rejecting anything that could
/// escape the project. Defence in layers:
///  1. lexical: reject empty / absolute / any `..` or root/prefix component, so the join
///     can't climb out before we ever touch the filesystem;
///  2. canonical: ensure the deepest EXISTING ancestor of the destination canonicalizes
///     to inside the canonical project root — this defeats a symlinked directory in the
///     path that lexical checks can't see.
/// Returns the absolute destination path (which may not exist yet, for `create`).
pub(super) fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
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
                return Err(format!("artifact path must be repo-relative, not absolute: {rel}"))
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
    if DENIED_TARGET_FILES.contains(&normalized.as_str()) {
        return Err(format!(
            "artifact path targets a protected CI configuration file: {rel}"
        ));
    }

    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("project root {} is not accessible: {e}", root.display()))?;
    let dest = root_canon.join(rel_path);

    // Walk the destination component-by-component from the root, using lstat
    // (`symlink_metadata`, which does NOT follow links — unlike `exists()`) and reject
    // ANY existing component that is a symlink, dangling or live. This is the real
    // symlink-escape guard: a DANGLING symlink leaf (e.g. an untrusted scanned repo
    // shipping `AGENTS.md -> /outside`) reports `exists() == false`, so a naive
    // ancestor walk skips past it and a later `fs::write` follows it OUT of the project
    // root. lstat sees the link itself. An in-root symlink (`AGENTS.md -> src/main.rs`)
    // is likewise rejected so a merge can't corrupt an unrelated repo file. A
    // not-yet-existing component is fine — there is nothing to follow.
    let mut current = root_canon.clone();
    for comp in rel_path.components() {
        let Component::Normal(name) = comp else {
            continue;
        };
        current.push(name);
        if let Ok(meta) = std::fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "artifact path passes through a symlink (rejected): {rel}"
                ));
            }
        }
    }

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

/// Write a brand-new file, FAILING if it already exists (never clobber). `create_new` is
/// the atomic no-clobber guard — it closes the check-then-write race a separate `exists()`
/// test would leave open. Creates any missing parent directories first.
pub(super) fn write_create(dest: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
    {
        Ok(mut file) => file
            .write_all(content.as_bytes())
            .map_err(|e| format!("failed to write {}: {e}", dest.display())),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(format!(
            "{} already exists — refusing to overwrite it",
            dest.display()
        )),
        Err(e) => Err(format!("cannot create {}: {e}", dest.display())),
    }
}

/// Insert or replace the managed block inside `dest` with `body`. The existing file (or
/// empty when absent) is read, the block between the markers is replaced (or appended if
/// no markers are present yet), and the result is written ATOMICALLY (temp file + rename).
/// The user's content outside the markers is preserved verbatim. The atomic rename also
/// hardens the write: `rename` REPLACES a destination symlink rather than following it (a
/// second guard atop `safe_join`'s symlink rejection), and a crash mid-write can never
/// truncate the user's hand-written CLAUDE.md/AGENTS.md.
pub(super) fn write_merge_section(dest: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let existing = std::fs::read_to_string(dest).unwrap_or_default();
    let merged = merge_managed_section(&existing, body);
    crate::store::write_atomic(dest, merged.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", dest.display()))
}

/// Pure: produce the new file contents with `body` placed inside the managed markers.
/// Replaces an existing managed block, or appends a fresh one (with a separating blank
/// line) when none is present. Kept pure so it is unit-testable without the filesystem.
fn merge_managed_section(existing: &str, body: &str) -> String {
    let block = format!("{SECTION_START}\n{}\n{SECTION_END}", body.trim_end());
    if let (Some(start), Some(end)) = (existing.find(SECTION_START), existing.find(SECTION_END)) {
        if end >= start {
            let end_full = end + SECTION_END.len();
            let mut out = String::with_capacity(existing.len() + body.len());
            out.push_str(&existing[..start]);
            out.push_str(&block);
            out.push_str(&existing[end_full..]);
            return out;
        }
    }
    if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    }
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
            assert!(result.is_err(), "symlinked dir escaping the root must be rejected");
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
        assert!(!outside.exists(), "nothing must have been written outside the root");
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
        // (a React `hooks/` dir) or non-executable `.github/` content (issue templates).
        let tmp = TempDir::new().unwrap();
        for ok in [
            "apps/web/src/hooks/useThing.ts",
            ".github/ISSUE_TEMPLATE/bug.md",
            ".github/CODEOWNERS",
            "packages/eslint-plugin/src/index.ts",
        ] {
            assert!(
                safe_join(tmp.path(), ok).is_ok(),
                "must allow non-sink path {ok:?}"
            );
        }
    }

    #[test]
    fn write_create_refuses_to_clobber() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("AGENTS.md");
        write_create(&dest, "first").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "first");
        // A second create must NOT overwrite.
        assert!(write_create(&dest, "second").is_err());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "first");
    }

    #[test]
    fn write_create_makes_missing_parent_dirs() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("packages/eslint-plugin/src/index.ts");
        write_create(&dest, "export {}").unwrap();
        assert!(dest.exists());
    }

    #[test]
    fn merge_section_appends_then_replaces_in_place() {
        // Append into existing content, preserving the user's prose.
        let original = "# Project\n\nHand-written intro.\n";
        let merged = merge_managed_section(original, "## Conventions\n- folder-per-component");
        assert!(merged.contains("Hand-written intro."));
        assert!(merged.contains(SECTION_START));
        assert!(merged.contains("folder-per-component"));

        // Re-applying replaces the managed block only, leaving the prose intact.
        let remerged = merge_managed_section(&merged, "## Conventions\n- no-cross-feature-imports");
        assert!(remerged.contains("Hand-written intro."));
        assert!(remerged.contains("no-cross-feature-imports"));
        assert!(!remerged.contains("folder-per-component"), "old block replaced");
        // Exactly one managed block remains.
        assert_eq!(remerged.matches(SECTION_START).count(), 1);
    }

    #[test]
    fn merge_section_into_empty_file() {
        let merged = merge_managed_section("", "## Conventions\n- x");
        assert!(merged.starts_with(SECTION_START));
        assert!(merged.contains("- x"));
    }
}
