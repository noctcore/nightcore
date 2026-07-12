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
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::infra::safe_join::safe_join;

/// The delimiters bounding the managed block a `merge-section` artifact owns inside a
/// CLAUDE.md / AGENTS.md. Re-applying replaces only the block between these markers, so
/// the user's surrounding hand-written content is never touched.
const SECTION_START: &str = "<!-- nightcore:harness:start -->";
const SECTION_END: &str = "<!-- nightcore:harness:end -->";

/// The one file the Structure-Lock manifest write mode may EVER target. This is a
/// POSITIVE allowlist of exactly one path — the counterpart to the execution-sink
/// denylist. `harness.json` drives the zero-agent-cost gate (`workflow::gauntlet_project`),
/// so an injected proposal that could author it freely would author the gate that is
/// supposed to police injected proposals. It is therefore never model-authored: the caller
/// (`apply_harness_artifact`) hands us a Rust-built check entry and we merge it here.
/// The spelling itself lives on the single manifest seam
/// ([`crate::store::harness_manifest`] — audit #35); this alias keeps the allowlist
/// local and auditable.
const MANIFEST_REL_PATH: &str = crate::store::harness_manifest::MANIFEST_REL_PATH;

/// Basenames a `merge-section` write may target. `merge-section` is the ONLY write mode
/// that reads and rewrites a pre-existing file, so its blast radius is any file the user
/// already has — a prompt-injected `agent-contract` pointed at an existing shell script or
/// dotfile would otherwise be merged in place. It exists solely to manage the agent-contract
/// docs, so restrict it to those (matched case-insensitively). `create` cannot reach these
/// existing-file sinks (it never clobbers) and is bounded by the denylists above instead.
const MERGE_SECTION_ALLOWED_BASENAMES: &[&str] = &["claude.md", "agents.md", "agent_contract.md"];

/// Re-assert, in the instant BEFORE the write syscall, that `dest`'s parent still
/// canonicalizes to inside `root`. This narrows the TOCTOU window that `safe_join`
/// alone leaves open: `safe_join` walks the path with per-component `lstat` and
/// returns, but the actual create/rename happens on a LATER syscall — a mid-path
/// directory component swapped to a symlink in between could redirect the write out
/// of the root. Called after `create_dir_all` (so the parent exists) and immediately
/// before the write, this collapses the exploitable gap to the single
/// `canonicalize(parent) → open` syscall pair. A path-based op can never make that
/// gap literally zero (only an `openat`/`O_NOFOLLOW` fd walk would), but combined
/// with `safe_join`'s lstat walk, `create_new`'s no-clobber, and the atomic rename
/// (which replaces rather than follows a destination symlink), the residual race is
/// sub-microsecond and the write path stays human-gated.
fn revalidate_parent_contained(root: &Path, dest: &Path) -> Result<(), String> {
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("project root {} is not accessible: {e}", root.display()))?;
    let parent = dest
        .parent()
        .ok_or_else(|| "artifact path has no parent directory".to_string())?;
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("cannot resolve {} before write: {e}", parent.display()))?;
    if parent_canon != root_canon && !parent_canon.starts_with(&root_canon) {
        return Err(format!(
            "artifact parent resolved outside the project root just before write: {}",
            dest.display()
        ));
    }
    // The leaf must not have become a symlink since safe_join's walk. `create_new`
    // already refuses an existing leaf, and the atomic rename replaces rather than
    // follows one, but reject explicitly so no writer can be surprised.
    if let Ok(meta) = std::fs::symlink_metadata(dest) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "artifact target became a symlink before write (rejected): {}",
                dest.display()
            ));
        }
    }
    Ok(())
}

/// Write a brand-new file, FAILING if it already exists (never clobber). `create_new` is
/// the atomic no-clobber guard — it closes the check-then-write race a separate `exists()`
/// test would leave open. Creates any missing parent directories first, then re-validates
/// (via [`revalidate_parent_contained`]) that the parent still resolves inside `root`
/// immediately before the open — narrowing the mid-path-symlink-swap TOCTOU window.
pub(super) fn write_create(root: &Path, dest: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    revalidate_parent_contained(root, dest)?;
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
pub(super) fn write_merge_section(root: &Path, dest: &Path, body: &str) -> Result<(), String> {
    // Allowlist the target: merge-section rewrites a pre-existing file, so it is confined
    // to the agent-contract docs it exists to manage. This is the positive counterpart to
    // the execution-sink denylist in `safe_join` — a denylist can miss a sink, but this
    // mode can ONLY ever legitimately write CLAUDE.md / AGENTS.md / AGENT_CONTRACT.md.
    let basename = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !MERGE_SECTION_ALLOWED_BASENAMES.contains(&basename.as_str()) {
        return Err(format!(
            "merge-section may only target an agent-contract doc (CLAUDE.md / AGENTS.md / AGENT_CONTRACT.md), not {}",
            dest.display()
        ));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    // Re-validate containment in the instant before the write (mid-path symlink-swap
    // TOCTOU narrowing) — the parent now exists, so canonicalize resolves it.
    revalidate_parent_contained(root, dest)?;
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

/// Arm (or re-arm) a Structure-Lock check in the target repo's `.nightcore/harness.json`,
/// merging `entry` into the `checks` array by `name`. This is how the Harden→Lock arrow
/// closes: applying a generated lint-plugin bundle deterministically writes the check that
/// the zero-cost gauntlet ([`crate::workflow::gauntlet_project`]) will run before every
/// reviewer and merge — but the entry is built in Rust from known-applied facts, NEVER from
/// model output, and the target is hard-pinned to exactly `.nightcore/harness.json` (this
/// function takes no caller-supplied path). Security posture is identical to
/// [`write_merge_section`]: the resolved destination is re-validated through [`safe_join`]
/// (symlink/containment) as defence in depth, and the write is atomic (temp + rename, which
/// replaces a destination symlink rather than following it). Returns the destination path.
pub(super) fn write_merge_manifest(root: &Path, entry: &Value) -> Result<PathBuf, String> {
    // Defence in depth: even though the path is a hardcoded constant, route it through the
    // same containment/symlink guard every other write uses (a symlinked `.nightcore/` or
    // `harness.json` pointing outside the repo is rejected, not followed).
    let dest = safe_join(root, MANIFEST_REL_PATH)?;
    let existing = std::fs::read_to_string(&dest).unwrap_or_default();
    let merged = merge_manifest_checks(&existing, entry);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    // Re-validate containment in the instant before the write (mid-path symlink-swap
    // TOCTOU narrowing), consistent with the other two writers.
    revalidate_parent_contained(root, &dest)?;
    crate::store::write_atomic(&dest, merged.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", dest.display()))?;
    Ok(dest)
}

/// Pure: merge one check `entry` into the manifest text, keyed by its `name`. An existing
/// check with the same `name` is REPLACED in place (arming is idempotent + updatable);
/// otherwise the entry is appended. Every other top-level key and every non-matching check
/// is preserved verbatim, so a hand-authored manifest is never clobbered — only the one
/// check we own is touched. A manifest that is absent, empty, malformed, or not a JSON
/// object starts fresh as `{ "checks": [entry] }`: the gauntlet already warn-and-skips a
/// malformed file, so replacing it with a valid one strictly improves the gate (and we
/// never had a parseable prior state to preserve). Kept pure for filesystem-free tests.
fn merge_manifest_checks(existing: &str, entry: &Value) -> String {
    let entry_name = entry.get("name").and_then(Value::as_str);

    // Start from the existing object when it parses to one; otherwise a fresh object.
    let mut root = match serde_json::from_str::<Value>(existing) {
        Ok(Value::Object(map)) => Value::Object(map),
        _ => json!({}),
    };
    let obj = root.as_object_mut().expect("root is an object");

    // Take the existing `checks` array (drop a non-array `checks` — it can't be merged).
    let mut checks: Vec<Value> = match obj.remove("checks") {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    };

    // Replace a same-name check in place, else append. A null/absent name always appends
    // (nothing to match), but callers always supply one.
    let replaced = entry_name.is_some()
        && checks.iter_mut().any(|c| {
            if c.get("name").and_then(Value::as_str) == entry_name {
                *c = entry.clone();
                true
            } else {
                false
            }
        });
    if !replaced {
        checks.push(entry.clone());
    }

    obj.insert("checks".to_string(), Value::Array(checks));
    // Pretty-print with a trailing newline so the file reads cleanly in a diff/editor.
    let mut out = serde_json::to_string_pretty(&root).unwrap_or_else(|_| "{}".to_string());
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn write_merge_section_confined_to_agent_docs() {
        // merge-section rewrites a pre-existing file, so it is allowlisted to the agent
        // docs it manages — a prompt-injected merge into any other existing file (an
        // execution sink the denylist might miss) is rejected outright.
        let tmp = TempDir::new().unwrap();
        for ok in [
            "CLAUDE.md",
            "AGENTS.md",
            "AGENT_CONTRACT.md",
            "docs/agents.md",
        ] {
            let dest = tmp.path().join(ok);
            assert!(
                write_merge_section(tmp.path(), &dest, "## Conventions\n- x").is_ok(),
                "must allow merge into agent doc {ok:?}"
            );
        }
        for bad in ["README.md", "src/index.ts", "deploy.sh", "config.json"] {
            let dest = tmp.path().join(bad);
            assert!(
                write_merge_section(tmp.path(), &dest, "malicious body").is_err(),
                "must reject merge into non-agent-doc {bad:?}"
            );
            assert!(!dest.exists(), "a rejected merge must not create {bad:?}");
        }
    }

    #[test]
    fn write_create_refuses_to_clobber() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("AGENTS.md");
        write_create(tmp.path(), &dest, "first").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "first");
        // A second create must NOT overwrite.
        assert!(write_create(tmp.path(), &dest, "second").is_err());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "first");
    }

    #[test]
    fn write_create_makes_missing_parent_dirs() {
        let tmp = TempDir::new().unwrap();
        let dest = tmp.path().join("packages/eslint-plugin/src/index.ts");
        write_create(tmp.path(), &dest, "export {}").unwrap();
        assert!(dest.exists());
    }

    #[cfg(unix)]
    #[test]
    fn writers_reject_a_mid_path_dir_swapped_to_a_symlink_before_write() {
        // TOCTOU narrowing: simulate the post-safe_join swap where a mid-path DIRECTORY
        // component is a symlink pointing OUTSIDE the root at write time. The pre-write
        // re-validation must canonicalize the parent, see it resolves outside root, and
        // refuse — for both writers — while a genuinely in-root parent still writes.
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();

        // `sub` is a symlink to an out-of-root dir; a naive write to `sub/AGENTS.md`
        // would land in `outside`. revalidate_parent_contained must reject it.
        std::os::unix::fs::symlink(outside.path(), root.path().join("sub")).unwrap();
        let escaping = root.path().join("sub").join("AGENTS.md");
        assert!(
            write_create(root.path(), &escaping, "x").is_err(),
            "create through a symlinked parent escaping root must be rejected"
        );
        assert!(
            write_merge_section(root.path(), &escaping, "## x\n- y").is_err(),
            "merge-section through a symlinked parent escaping root must be rejected"
        );
        assert!(
            !outside.path().join("AGENTS.md").exists(),
            "nothing may be written outside the root"
        );

        // First-party control: a real in-root parent still writes.
        let ok = root.path().join("nested").join("AGENTS.md");
        assert!(write_create(root.path(), &ok, "first-party").is_ok());
        assert_eq!(std::fs::read_to_string(&ok).unwrap(), "first-party");
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
        assert!(
            !remerged.contains("folder-per-component"),
            "old block replaced"
        );
        // Exactly one managed block remains.
        assert_eq!(remerged.matches(SECTION_START).count(), 1);
    }

    #[test]
    fn merge_section_into_empty_file() {
        let merged = merge_managed_section("", "## Conventions\n- x");
        assert!(merged.starts_with(SECTION_START));
        assert!(merged.contains("- x"));
    }

    /// Parse a merged-manifest string back to the `checks` array for assertions.
    fn checks_of(manifest: &str) -> Vec<Value> {
        serde_json::from_str::<Value>(manifest)
            .unwrap()
            .get("checks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    }

    #[test]
    fn merge_manifest_seeds_a_fresh_file() {
        let entry = json!({ "name": "folder-per-component", "kind": "lint-plugin", "command": "sh -c true" });
        let out = merge_manifest_checks("", &entry);
        let checks = checks_of(&out);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0]["name"], "folder-per-component");
        assert!(out.ends_with('\n'), "trailing newline for clean diffs");
    }

    #[test]
    fn merge_manifest_appends_a_distinct_check() {
        let first = merge_manifest_checks(
            "",
            &json!({ "name": "lint", "kind": "lint-plugin", "command": "a" }),
        );
        let out = merge_manifest_checks(
            &first,
            &json!({ "name": "arch", "kind": "dependency-cruiser", "command": "b" }),
        );
        let checks = checks_of(&out);
        let names: Vec<&str> = checks.iter().map(|c| c["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec!["lint", "arch"],
            "distinct names both kept, in order"
        );
    }

    #[test]
    fn merge_manifest_replaces_a_same_name_check_in_place() {
        // Arming the same check twice UPDATES it (idempotent + re-armable), never
        // duplicates — the gauntlet would otherwise run the stale command too.
        let first = merge_manifest_checks(
            "",
            &json!({ "name": "lint", "kind": "lint-plugin", "command": "old" }),
        );
        let out = merge_manifest_checks(
            &first,
            &json!({ "name": "lint", "kind": "lint-plugin", "command": "new" }),
        );
        let checks = checks_of(&out);
        assert_eq!(checks.len(), 1, "same name replaced, not appended");
        assert_eq!(checks[0]["command"], "new");
    }

    #[test]
    fn merge_manifest_preserves_hand_authored_checks_and_unknown_keys() {
        // A user's existing manifest (a hand-written check + an unknown top-level key)
        // must survive arming untouched — we only ever own the one check we write.
        let existing = r#"{
            "version": 2,
            "checks": [
                { "name": "my-own", "kind": "coverage-threshold", "command": "npm run cov", "enabled": true }
            ]
        }"#;
        let out = merge_manifest_checks(
            existing,
            &json!({ "name": "generated", "kind": "lint-plugin", "command": "npx eslint ." }),
        );
        let root: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(root["version"], 2, "unknown top-level key preserved");
        let checks = checks_of(&out);
        let names: Vec<&str> = checks.iter().map(|c| c["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec!["my-own", "generated"],
            "user's check preserved + ours appended"
        );
        assert_eq!(
            checks[0]["command"], "npm run cov",
            "user's check body untouched"
        );
    }

    #[test]
    fn merge_manifest_resets_a_malformed_file() {
        // A malformed manifest is warn-and-skipped by the gauntlet anyway, so replacing
        // it with a valid single-check file strictly improves the gate.
        let out = merge_manifest_checks(
            "{ this is not json",
            &json!({ "name": "lint", "kind": "lint-plugin", "command": "x" }),
        );
        let checks = checks_of(&out);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0]["name"], "lint");
    }

    #[test]
    fn merge_manifest_reseeds_when_checks_is_not_an_array() {
        // A `checks` that is an object (not an array) can't be merged — drop it and seed
        // a valid array rather than crashing.
        let out = merge_manifest_checks(
            r#"{ "checks": { "oops": true }, "keep": 1 }"#,
            &json!({ "name": "lint", "kind": "lint-plugin", "command": "x" }),
        );
        let root: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(root["keep"], 1, "sibling keys preserved");
        assert_eq!(checks_of(&out).len(), 1);
    }

    #[test]
    fn write_merge_manifest_arms_a_loadable_config() {
        // End-to-end: the writer lands a real `.nightcore/harness.json` that round-trips
        // as valid JSON with our check present. (The gauntlet's own loader is tested in
        // `workflow::gauntlet_project`; here we prove the file it will read is well-formed.)
        let tmp = TempDir::new().unwrap();
        let entry = json!({ "name": "folder-per-component", "kind": "lint-plugin", "command": "npx eslint ." });
        let dest = write_merge_manifest(tmp.path(), &entry).unwrap();
        assert!(dest.ends_with(".nightcore/harness.json"));
        let on_disk = std::fs::read_to_string(&dest).unwrap();
        let checks = checks_of(&on_disk);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0]["kind"], "lint-plugin");

        // A second arm of a different check appends (the file persists across applies).
        write_merge_manifest(
            tmp.path(),
            &json!({ "name": "arch", "kind": "dependency-cruiser", "command": "npx depcruise src" }),
        )
        .unwrap();
        let after = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(checks_of(&after).len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn armed_manifest_is_actually_run_by_the_structure_lock_gauntlet() {
        // The whole point of the writer: a check armed here must be picked up + executed by
        // the gauntlet that had no producer before. Arm a trivially-passing check, then run
        // the real `gauntlet_project::run` over the dir and assert it planned + ran it.
        // (Proves the spec's previously-broken Harden→Lock arrow now closes end-to-end.)
        let tmp = TempDir::new().unwrap();
        write_merge_manifest(
            tmp.path(),
            &json!({ "name": "folder-per-component", "kind": "lint-plugin", "command": "sh -c true", "enabled": true }),
        )
        .unwrap();
        let result = crate::workflow::gauntlet_project::run(tmp.path());
        assert!(result.passed, "the armed passing check runs and passes");
        assert_eq!(
            result.checks.len(),
            1,
            "the gauntlet loaded our armed check"
        );
        assert_eq!(result.checks[0].name, "folder-per-component");
    }

    #[cfg(unix)]
    #[test]
    fn write_merge_manifest_rejects_a_symlinked_manifest_escaping_the_root() {
        // Defence in depth: a scanned repo shipping `.nightcore` as a symlink to an
        // outside dir must not let the arming write escape the project root.
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join(".nightcore")).unwrap();
        let entry = json!({ "name": "lint", "kind": "lint-plugin", "command": "x" });
        assert!(
            write_merge_manifest(root.path(), &entry).is_err(),
            "a symlinked .nightcore escaping the root must be rejected"
        );
        assert!(
            !outside.path().join("harness.json").exists(),
            "nothing written outside the root"
        );
    }
}
