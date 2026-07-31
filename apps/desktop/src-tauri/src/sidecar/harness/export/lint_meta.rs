//! The portable lint-meta half of the export (#325): which rules travel in the
//! bundle, the registry that enumerates them, and the manifest command that runs
//! them in a foreign CI.
//!
//! ## Where the rules come from (decision 3)
//! ONLY `lint-meta-rule` artifacts the user actually APPLIED — read from their
//! `appliedPath` off disk. An applied rule is a real file that travels with a
//! checkout; a merely *proposed* one exists nowhere but a scan record. The applied
//! paths are recovered from the on-disk scan records under `.nightcore/harness/`, so
//! [`write_portable_lock`](super::writer::write_portable_lock) keeps taking nothing
//! but a `project_path` — no store handle, no run id, no scan-store coupling.
//!
//! ## Why the emitted registry is TypeScript (decision 1)
//! The rules are TypeScript, and this writer is deterministic Rust that NEVER shells
//! out — the trust basis of a path that writes CI config into someone else's repo.
//! Regex type-stripping in Rust was rejected (it silently corrupts non-erasable TS —
//! enum / decorator / parameter property / namespace — and the rules are
//! LLM-authored, so the input is unbounded), as was shelling out to esbuild. So the
//! rules are copied BYTE-FOR-BYTE and the registry is emitted as TypeScript; the
//! published `@noctcore/harness` runner strips the types as it loads them (Node ≥ 22.18).
//!
//! Two consequences the emitted bundle handles explicitly:
//! - the bundle's modules are `.mts`, not `.ts`. A `.ts` file's module system is decided
//!   by the nearest `package.json`, so in a repo declaring `"type": "commonjs"` Node
//!   rejects the ES-module rules with `Cannot use import statement outside a module`.
//!   `.mts` is unconditionally ESM. The obvious alternative — writing a
//!   `{"type":"module"}` `package.json` beside them — is impossible BY DESIGN: `package.json`
//!   is a protected execution sink in [`safe_join`] (it can carry lifecycle scripts), and
//!   that denylist is not something an exporter gets to weaken. Only the EXTENSION
//!   changes; the file bytes are copied untouched.
//! - the registry imports each rule module as a NAMESPACE and picks out its
//!   rule-shaped exports, because a generated rule may export its rule under any name
//!   (or as an array, or as the default).

use std::collections::{BTreeSet, HashSet};
use std::path::Path;

use serde_json::{json, Value};

use crate::infra::safe_join::safe_join;

/// The `checks[].kind` whose command the bundle translates to the portable runner.
const LINT_META_KIND: &str = "lint-meta";

/// The artifact `kind` that carries a generated lint-meta rule.
const LINT_META_RULE_KIND: &str = "lint-meta-rule";

/// The artifact lifecycle state whose file exists on disk.
const APPLIED_STATUS: &str = "applied";

/// The project-relative dir holding the on-disk Harness scan records.
const HARNESS_RUNS_DIR_REL: &str = ".nightcore/harness";

/// The bundle-relative dir holding the portable lint-meta payload.
pub(super) const LINT_META_SUBDIR: &str = "lint-meta";

/// The bundle-relative dir (under [`LINT_META_SUBDIR`]) holding the copied rules.
pub(super) const RULES_SUBDIR: &str = "rules";

/// The emitted registry's basename. TypeScript (see the module docs) and `.mts` so it
/// is ESM whatever the target repo's `package.json` says.
pub(super) const REGISTRY_BASENAME: &str = "registry.mts";

/// How a source rule's extension maps to its bundle extension. Ambiguous extensions
/// (`.ts`/`.js`, whose module system the nearest `package.json` decides) are pinned to
/// their unambiguous ESM form; the already-unambiguous ones travel as they are. Any
/// extension not listed here is not a loadable module and is skipped.
const RULE_EXTENSIONS: [(&str, &str); 6] = [
    ("ts", "mts"),
    ("mts", "mts"),
    ("cts", "cts"),
    ("js", "mjs"),
    ("mjs", "mjs"),
    ("cjs", "cjs"),
];

/// Hard cap on rules copied into one bundle — a corrupt/hostile scan record cannot
/// make the exporter copy an unbounded number of files.
const MAX_RULES: usize = 200;

/// One applied rule staged into the bundle: its bundle-relative file name under
/// `lint-meta/rules/`, the VERBATIM file bytes, and the repo path it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ExportedRule {
    pub file_name: String,
    pub content: String,
    pub source_rel: String,
}

/// The command an exported `lint-meta` check runs: the PUBLISHED runner, pinned to
/// the same version as the workflow, pointed at the bundle's own registry. `--registry`
/// is explicit on purpose — the runner treats an explicitly named registry as
/// fail-closed, so a bundle whose registry went missing reds CI instead of passing
/// with nothing to enforce.
pub(super) fn lint_meta_command(runner_version: &str, registry_rel: &str) -> String {
    format!("npx --yes @noctcore/harness@{runner_version} lint-meta --registry {registry_rel}")
}

/// Every APPLIED `lint-meta-rule` file, read off disk, in a deterministic order.
///
/// Never fails the export: an unreadable scan dir, a corrupt record, or a rule whose
/// file has since been deleted simply contributes nothing. Containment is enforced —
/// each `appliedPath` resolves through [`safe_join`], so a tampered scan record cannot
/// make the exporter read (and then publish) a file outside the project.
pub(super) fn collect_applied_rules(root: &Path) -> Vec<ExportedRule> {
    let mut taken: HashSet<String> = HashSet::new();
    let mut rules = Vec::new();

    for rel in applied_rule_paths(root) {
        if rules.len() >= MAX_RULES {
            break;
        }
        let Some(base) = bundle_file_name(&rel) else {
            continue;
        };
        let Ok(abs) = safe_join(root, &rel) else {
            continue;
        };
        let Ok(content) = std::fs::read_to_string(&abs) else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        let file_name = disambiguate(base, &mut taken);
        rules.push(ExportedRule {
            file_name,
            content,
            source_rel: rel,
        });
    }
    rules
}

/// The deduplicated, sorted `appliedPath`s of every applied `lint-meta-rule` recorded
/// in the project's on-disk scan records.
///
/// The records are read as plain JSON rather than through `HarnessStore` so the export
/// stays a pure function of `project_path` + on-disk state (no store handle, no boot
/// reap, no write-back). The three keys read here are pinned against the persisted
/// `StoredProposedArtifact` shape by a test below, so the two cannot drift silently.
fn applied_rule_paths(root: &Path) -> BTreeSet<String> {
    let mut paths = BTreeSet::new();
    let Ok(dir) = safe_join(root, HARNESS_RUNS_DIR_REL) else {
        return paths;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return paths;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(run) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(artifacts) = run.get("artifacts").and_then(Value::as_array) else {
            continue;
        };
        for artifact in artifacts {
            let kind = artifact.get("kind").and_then(Value::as_str);
            let status = artifact.get("status").and_then(Value::as_str);
            if kind != Some(LINT_META_RULE_KIND) || status != Some(APPLIED_STATUS) {
                continue;
            }
            if let Some(applied) = artifact.get("appliedPath").and_then(Value::as_str) {
                let trimmed = applied.trim();
                if !trimmed.is_empty() {
                    paths.insert(trimmed.to_string());
                }
            }
        }
    }
    paths
}

/// The bundle file name for a repo-relative rule path: its BASENAME, sanitized to
/// `[A-Za-z0-9._-]` with the extension pinned to its unambiguous module form, or `None`
/// when it does not name a loadable module. Taking only the basename means no directory
/// component (and so no traversal) can survive; the destination still resolves through
/// `safe_join` before any write.
fn bundle_file_name(rel: &str) -> Option<String> {
    let base = Path::new(rel).file_name()?.to_str()?;
    let ext = Path::new(base).extension()?.to_str()?.to_ascii_lowercase();
    let (_, bundle_ext) = RULE_EXTENSIONS.iter().find(|(from, _)| *from == ext)?;

    let stem = base.get(..base.len() - ext.len() - 1)?;
    let sanitized: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect();
    // Never a dotfile, and never an empty name once sanitized.
    let cleaned = sanitized.trim_start_matches(['.', '-']);
    if cleaned.is_empty() {
        return None;
    }
    Some(format!("{cleaned}.{bundle_ext}"))
}

/// Make `name` unique within the bundle by appending `-2`, `-3`, … before the
/// extension. Deterministic because the caller iterates a sorted path set.
fn disambiguate(name: String, taken: &mut HashSet<String>) -> String {
    if taken.insert(name.clone()) {
        return name;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem.to_string(), format!(".{ext}")),
        None => (name.clone(), String::new()),
    };
    for n in 2..=(MAX_RULES + 1) {
        let candidate = format!("{stem}-{n}{ext}");
        if taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    name
}

/// The deterministic `registry.ts` for `rules` — the ONE module the runner imports.
///
/// Each rule module is imported as a NAMESPACE and its rule-shaped exports collected at
/// load time, because a generated rule may export its rule under any name, as an array,
/// or as the default. Callers must not emit a registry for an empty rule set: a registry
/// exporting zero rules is a silent no-op CI, so an absent registry (which the runner
/// treats as fail-closed under `--registry`) is the honest state.
pub(super) fn registry_source(rules: &[ExportedRule]) -> String {
    let mut out = String::from(
        "// Generated by Nightcore — the portable lint-meta rule registry. DO NOT EDIT:\n\
         // re-exporting the portable lock overwrites this file.\n\
         //\n\
         // `npx @noctcore/harness lint-meta --registry <this file>` imports THIS module and\n\
         // nothing else, then runs every rule it exports. The rule files beside it are\n\
         // VERBATIM copies of the ones in this repo — only their extension is pinned to\n\
         // .mts (unconditionally an ES module, whatever this repo's package.json says).\n\
         // The runner strips their TypeScript types as it loads them (Node >= 22.18).\n\
         import type { IMetaRule } from '@noctcore/harness';\n\
         \n",
    );

    for (i, rule) in rules.iter().enumerate() {
        out.push_str(&format!(
            "// {}\nimport * as rule{i} from './{RULES_SUBDIR}/{}';\n",
            rule.source_rel, rule.file_name
        ));
    }

    out.push_str(
        "\n\
         /** A structurally rule-shaped value: an `id` string and a `run` function. */\n\
         function isRule(value: unknown): value is IMetaRule {\n\
         \x20 if (typeof value !== 'object' || value === null) return false;\n\
         \x20 const rule = value as { id?: unknown; run?: unknown };\n\
         \x20 return typeof rule.id === 'string' && typeof rule.run === 'function';\n\
         }\n\
         \n\
         /** Every rule a module exports — under any name, as an array, or as the default. */\n\
         function rulesOf(mod: unknown): IMetaRule[] {\n\
         \x20 if (typeof mod !== 'object' || mod === null) return [];\n\
         \x20 const found: IMetaRule[] = [];\n\
         \x20 for (const value of Object.values(mod)) {\n\
         \x20   if (Array.isArray(value)) found.push(...value.filter(isRule));\n\
         \x20   else if (isRule(value)) found.push(value);\n\
         \x20 }\n\
         \x20 return found;\n\
         }\n\
         \n\
         export const META_RULES: IMetaRule[] = [\n",
    );
    for (i, _) in rules.iter().enumerate() {
        out.push_str(&format!("  rule{i},\n"));
    }
    out.push_str("].flatMap(rulesOf);\n");
    out
}

/// Rewrite every `lint-meta` check's `command` in `manifest_json` to `command`,
/// returning the new text and how many checks were translated.
///
/// This is the ONE committed manifest a target repo's CI reads (decision 2). The live
/// `.nightcore/harness.json` keeps its `<pm> run <script>` form — Nightcore's own arm
/// gate (`validate_lint_meta_shape`) rejects `npx`, and a target repo's CI has neither
/// the package manager nor the installed dependencies that form needs.
///
/// Only an EXISTING non-blank `command` is replaced: a check that declares none is not
/// runnable, and the exporter must never turn a dormant entry into an executing one.
/// When nothing is translated the input text is returned verbatim (no reformat churn).
pub(super) fn translate_lint_meta_commands(
    manifest_json: &str,
    command: &str,
) -> Result<(String, usize), String> {
    let mut root: Value = serde_json::from_str(manifest_json)
        .map_err(|e| format!("the stamped manifest is not valid JSON: {e}"))?;

    let mut translated = 0usize;
    if let Some(checks) = root.get_mut("checks").and_then(Value::as_array_mut) {
        for check in checks.iter_mut() {
            let Some(obj) = check.as_object_mut() else {
                continue;
            };
            if obj.get("kind").and_then(Value::as_str) != Some(LINT_META_KIND) {
                continue;
            }
            let runnable = obj
                .get("command")
                .and_then(Value::as_str)
                .is_some_and(|c| !c.trim().is_empty());
            if !runnable {
                continue;
            }
            obj.insert("command".to_string(), json!(command));
            translated += 1;
        }
    }

    if translated == 0 {
        return Ok((manifest_json.to_string(), 0));
    }
    let text = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("failed to serialize the exported manifest: {e}"))?;
    Ok((text, translated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn rule(file_name: &str, source_rel: &str) -> ExportedRule {
        ExportedRule {
            file_name: file_name.to_string(),
            content: "export const rule = {};\n".to_string(),
            source_rel: source_rel.to_string(),
        }
    }

    /// Write a scan record holding `artifacts` under `.nightcore/harness/<id>.json`.
    fn seed_run(tmp: &TempDir, id: &str, artifacts: Value) {
        let dir = tmp.path().join(HARNESS_RUNS_DIR_REL);
        std::fs::create_dir_all(&dir).expect("create scan dir");
        let run = json!({ "id": id, "projectPath": tmp.path(), "artifacts": artifacts });
        std::fs::write(
            dir.join(format!("{id}.json")),
            serde_json::to_string_pretty(&run).unwrap(),
        )
        .expect("write run");
    }

    fn seed_file(tmp: &TempDir, rel: &str, body: &str) {
        let path = tmp.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).expect("create parent");
        std::fs::write(path, body).expect("write file");
    }

    fn applied(kind: &str, status: &str, applied_path: &str) -> Value {
        json!({ "id": applied_path, "kind": kind, "status": status, "appliedPath": applied_path })
    }

    #[test]
    fn collects_only_applied_lint_meta_rules_that_still_exist_on_disk() {
        // Applied + present ⇒ exported. Proposed, dismissed, another artifact kind, or an
        // applied path whose file is gone ⇒ nothing (only applied rules are real).
        let tmp = TempDir::new().unwrap();
        seed_run(
            &tmp,
            "run-1",
            json!([
                applied("lint-meta-rule", "applied", "tools/lint-meta/rules/a.ts"),
                applied("lint-meta-rule", "proposed", "tools/lint-meta/rules/b.ts"),
                applied("lint-meta-rule", "dismissed", "tools/lint-meta/rules/c.ts"),
                applied("eslint-rule", "applied", "eslint/rules/d.ts"),
                applied("lint-meta-rule", "applied", "tools/lint-meta/rules/gone.ts"),
            ]),
        );
        seed_file(
            &tmp,
            "tools/lint-meta/rules/a.ts",
            "export const a = { id: 'a' };",
        );
        seed_file(&tmp, "tools/lint-meta/rules/b.ts", "export const b = {};");
        seed_file(&tmp, "tools/lint-meta/rules/c.ts", "export const c = {};");
        seed_file(&tmp, "eslint/rules/d.ts", "module.exports = {};");

        let rules = collect_applied_rules(tmp.path());
        assert_eq!(rules.len(), 1, "only the applied, present lint-meta rule");
        assert_eq!(
            rules[0].file_name, "a.mts",
            "the extension is pinned to ESM"
        );
        assert_eq!(rules[0].source_rel, "tools/lint-meta/rules/a.ts");
        assert_eq!(rules[0].content, "export const a = { id: 'a' };");
    }

    #[test]
    fn the_wire_keys_match_the_persisted_artifact_shape() {
        // The collector reads the scan record as plain JSON (no store coupling), so pin
        // its three keys against the REAL serialized `StoredProposedArtifact` — if the
        // persisted shape ever renames one, this fails instead of silently exporting
        // zero rules.
        let mut artifact = crate::store::harness::StoredProposedArtifact {
            id: "a1".into(),
            kind: LINT_META_RULE_KIND.into(),
            group: None,
            group_title: None,
            title: "t".into(),
            description: "d".into(),
            rationale: None,
            target_path: "tools/lint-meta/rules/a.ts".into(),
            write_mode: "create".into(),
            content: "export const a = {};".into(),
            language: Some("typescript".into()),
            source_findings: vec![],
            depends_on: vec![],
            confidence: None,
            fingerprint: "fp".into(),
            status: APPLIED_STATUS.into(),
            applied_path: Some("tools/lint-meta/rules/a.ts".into()),
            applied_at: Some(1),
        };
        artifact.applied_path = Some("tools/lint-meta/rules/a.ts".into());

        let tmp = TempDir::new().unwrap();
        seed_run(
            &tmp,
            "run-1",
            json!([serde_json::to_value(&artifact).unwrap()]),
        );
        seed_file(&tmp, "tools/lint-meta/rules/a.ts", "export const a = {};");

        let rules = collect_applied_rules(tmp.path());
        assert_eq!(
            rules.len(),
            1,
            "the collector must read the REAL persisted artifact shape"
        );
    }

    #[test]
    fn collection_is_deterministic_deduplicated_and_collision_safe() {
        // The same rule applied across two scans is exported once; two rules sharing a
        // basename both travel under distinct names; the order is stable (sorted by path).
        let tmp = TempDir::new().unwrap();
        seed_run(
            &tmp,
            "run-1",
            json!([applied("lint-meta-rule", "applied", "b/rules/dup.ts")]),
        );
        seed_run(
            &tmp,
            "run-2",
            json!([
                applied("lint-meta-rule", "applied", "b/rules/dup.ts"),
                applied("lint-meta-rule", "applied", "a/rules/dup.ts"),
            ]),
        );
        seed_file(&tmp, "a/rules/dup.ts", "export const a = {};");
        seed_file(&tmp, "b/rules/dup.ts", "export const b = {};");

        let first = collect_applied_rules(tmp.path());
        let second = collect_applied_rules(tmp.path());
        assert_eq!(first, second, "collection is deterministic across runs");
        assert_eq!(
            first
                .iter()
                .map(|r| (r.source_rel.as_str(), r.file_name.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("a/rules/dup.ts", "dup.mts"),
                ("b/rules/dup.ts", "dup-2.mts")
            ],
        );
    }

    #[test]
    fn non_module_and_traversing_paths_are_refused() {
        // A rule path must name a loadable module, and nothing may escape the project.
        // Ambiguous extensions are pinned to their unconditionally-ESM form so the copies
        // load in a repo that declares `"type": "commonjs"`.
        assert_eq!(bundle_file_name("rules/a.ts").as_deref(), Some("a.mts"));
        assert_eq!(bundle_file_name("rules/a.mts").as_deref(), Some("a.mts"));
        assert_eq!(bundle_file_name("rules/a.js").as_deref(), Some("a.mjs"));
        assert_eq!(bundle_file_name("rules/a.cjs").as_deref(), Some("a.cjs"));
        assert_eq!(bundle_file_name("../../etc/a.ts").as_deref(), Some("a.mts"));
        assert_eq!(
            bundle_file_name("rules/a b;rm -rf.ts").as_deref(),
            Some("a-b-rm--rf.mts")
        );
        assert!(bundle_file_name("rules/RULES.md").is_none());
        assert!(bundle_file_name("rules/noext").is_none());
        assert!(bundle_file_name(".ts").is_none());
        assert!(bundle_file_name("rules/").is_none());

        // …and a scan record pointing outside the project exports nothing.
        let tmp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("evil.ts"), "export const x = {};").unwrap();
        seed_run(
            &tmp,
            "run-1",
            json!([applied("lint-meta-rule", "applied", "../evil.ts")]),
        );
        assert!(
            collect_applied_rules(tmp.path()).is_empty(),
            "a traversing appliedPath must never be read into the bundle"
        );
    }

    #[test]
    fn an_absent_or_corrupt_scan_store_exports_no_rules_and_never_panics() {
        let tmp = TempDir::new().unwrap();
        assert!(collect_applied_rules(tmp.path()).is_empty(), "no scan dir");

        let dir = tmp.path().join(HARNESS_RUNS_DIR_REL);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("broken.json"), "{ not json").unwrap();
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap();
        std::fs::write(dir.join("shapeless.json"), r#"{ "artifacts": 7 }"#).unwrap();
        assert!(collect_applied_rules(tmp.path()).is_empty());
    }

    #[test]
    fn the_registry_enumerates_every_rule_and_imports_nothing_else() {
        let source = registry_source(&[rule("a.mts", "tools/rules/a.ts"), rule("b.mts", "x/b.ts")]);

        assert!(source.contains("import * as rule0 from './rules/a.mts';"));
        assert!(source.contains("import * as rule1 from './rules/b.mts';"));
        assert!(source.contains(
            "export const META_RULES: IMetaRule[] = [\n  rule0,\n  rule1,\n].flatMap(rulesOf);"
        ));
        // The ONLY package import is the type-only contract, which type-stripping erases —
        // nothing needs resolving at run time in the target repo.
        assert_eq!(source.matches("from '@noctcore/harness'").count(), 1);
        assert!(source.contains("import type { IMetaRule } from '@noctcore/harness';"));
        // Provenance for a reviewer reading the diff.
        assert!(source.contains("// tools/rules/a.ts"));
        // Deterministic.
        assert_eq!(
            source,
            registry_source(&[rule("a.mts", "tools/rules/a.ts"), rule("b.mts", "x/b.ts")])
        );
    }

    #[test]
    fn lint_meta_commands_are_translated_to_the_published_runner() {
        let manifest = serde_json::to_string_pretty(&json!({
            "schemaVersion": 1,
            "checks": [
                { "name": "folder-per-component", "kind": "lint-meta", "command": "bun run lint:meta" },
                { "name": "eslint", "kind": "lint-plugin", "command": "npx eslint ." },
                { "name": "dormant", "kind": "lint-meta" },
            ]
        }))
        .unwrap();

        let command = lint_meta_command(
            "0.2.0",
            ".nightcore/export/portable-lock/lint-meta/registry.ts",
        );
        let (text, translated) = translate_lint_meta_commands(&manifest, &command).unwrap();
        assert_eq!(translated, 1);

        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value["checks"][0]["command"],
            "npx --yes @noctcore/harness@0.2.0 lint-meta --registry .nightcore/export/portable-lock/lint-meta/registry.ts"
        );
        assert_eq!(
            value["checks"][1]["command"], "npx eslint .",
            "a non-lint-meta check is untouched"
        );
        assert!(
            value["checks"][2].get("command").is_none(),
            "a check with no command is never given one"
        );
        // The check identity (what the gauntlet armed) survives the translation.
        assert_eq!(value["checks"][0]["name"], "folder-per-component");
        assert_eq!(value["schemaVersion"], 1);
    }

    #[test]
    fn a_manifest_with_nothing_to_translate_is_returned_verbatim() {
        let manifest = r#"{ "schemaVersion": 1, "checks": [] }"#;
        let (text, translated) = translate_lint_meta_commands(manifest, "cmd").unwrap();
        assert_eq!(translated, 0);
        assert_eq!(text, manifest, "no reformat churn when nothing changed");

        let (text, translated) =
            translate_lint_meta_commands(r#"{ "schemaVersion": 1 }"#, "cmd").unwrap();
        assert_eq!(translated, 0);
        assert_eq!(text, r#"{ "schemaVersion": 1 }"#);

        assert!(translate_lint_meta_commands("{ not json", "cmd").is_err());
    }
}
