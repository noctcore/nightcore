//! The portable Structure-Lock export writer (portable lock PR 3, #134) — NEW and
//! SEPARATE from [`crate::sidecar::harness::apply`], which stays frozen.
//!
//! It stages a portable-lock bundle under `.nightcore/export/portable-lock/` so a
//! target repo can enforce its Structure-Lock outside Nightcore (plain CI, no
//! account, no server): a `schemaVersion`-stamped copy of the live manifest, a
//! deterministic `nightcore-lock.yml` GitHub Actions workflow that invokes the
//! published `@noctcore/harness` runner, a `README.md` with the ONE manual step
//! (copy the workflow into `.github/workflows/` yourself and commit it), and — when
//! the project has applied lint-meta rules — the portable lint-meta payload
//! ([`super::lint_meta`]): the copied rule files plus the registry that enumerates them.
//!
//! ## The bundle copy is the manifest CI reads (#325 decision 2)
//! The bundle's `harness.json` is not a review artifact: it is the ONE committed
//! manifest a target repo's CI reads, which is why the staged workflow points at it
//! with `--manifest`. Its `lint-meta` commands are translated to the published runner,
//! because the live manifest's `<pm> run <script>` form needs a package manager and
//! installed dependencies that a bare CI checkout does not have. The LIVE
//! `.nightcore/harness.json` is only ever stamped, never command-rewritten — Nightcore's
//! own arm gate (`validate_lint_meta_shape`) rejects the `npx` form.
//!
//! ## Why this is not `apply.rs` and why the workflow is STAGED
//! `.github/workflows/` is a DENIED write sink in [`crate::infra::safe_join`] precisely
//! because a file there auto-runs on the next push — so a CI workflow is human-committed
//! by design, NEVER tool-placed. The exporter therefore writes the workflow to the
//! staging dir and the README tells the user to copy it into `.github/workflows/`
//! themselves. This keeps the "never auto-write a CI sink" invariant intact WITHOUT
//! touching or weakening `apply.rs`.
//!
//! ## Trust basis
//! Every byte written here is DETERMINISTIC Rust template output, never model output —
//! the same trust basis as `write_merge_manifest`'s Rust-built check entry
//! (`apply.rs`). Containment still matters (a scanned repo may ship a symlinked
//! `.nightcore`), so each destination resolves through the shared
//! [`crate::infra::safe_join`] (symlink-escape + canonical containment) BEFORE any
//! write, mirroring `write_merge_manifest`'s guard. Re-export overwrites ONLY the
//! staging dir (idempotent, reviewable via `git diff`) and never touches live
//! `.github/workflows/`.

use std::path::{Path, PathBuf};

use serde::Serialize;
// `ts-rs` is a dev-dependency; the codegen derive is gated to `cfg(test)`.
#[cfg(test)]
use ts_rs::TS;

use super::lint_meta::{self, ExportedRule, LINT_META_SUBDIR, REGISTRY_BASENAME, RULES_SUBDIR};
use crate::infra::safe_join::safe_join;
use crate::store::harness_manifest::stamp_live_manifest;

/// The pinned `@noctcore/harness` runner version the exported CI workflow invokes.
/// Kept in lockstep with the published `@noctcore/harness` version (`packages/harness`);
/// never `@latest` — a target's CI must be reproducible (spec §5) and a compromised
/// future publish must not silently reach already-scaffolded repos. `0.2.0` is the first
/// runner that understands `--manifest` and a TypeScript rule registry (#325), so a
/// bundle exported by this build REQUIRES it: publishing lags a merge (a human pushes
/// the `harness-v<version>` tag), and until it lands an exported workflow reds with an
/// `npx` resolution failure — loud, never a silent pass.
pub const PORTABLE_LOCK_RUNNER_VERSION: &str = "0.2.0";

/// The staging bundle's project-relative directory. A CONTAINED, NON-execution-sink
/// path (NOT one of `safe_join`'s denied sinks): the workflow YAML is staged here for
/// the human to copy into `.github/workflows/` (a denied sink), never auto-written.
const EXPORT_DIR_REL: &str = ".nightcore/export/portable-lock";

/// The bundle's manifest — the ONE file the exported CI reads (`--manifest`).
const MANIFEST_BASENAME: &str = "harness.json";
/// The staged GitHub Actions workflow (copied into `.github/workflows/` by a human).
const WORKFLOW_BASENAME: &str = "nightcore-lock.yml";
/// The bundle's own README (what it is, the ONE manual step, the trust caveat).
const README_BASENAME: &str = "README.md";

/// One staged bundle entry: WHERE it goes and WHICH content fills it. The paths are
/// resolved (and containment-checked) before any content is computed, so the
/// safe_join gate still runs before the live-manifest stamp can write anything.
enum BundleFile {
    Manifest,
    Workflow,
    Readme,
    /// `lint-meta/registry.mts` — the enumerated registry the runner imports.
    Registry,
    /// `lint-meta/rules/<name>` — a VERBATIM copy of an applied rule file.
    Rule(usize),
}

/// The bundle-relative path of the emitted registry (what `--registry` names).
fn registry_rel() -> String {
    format!("{EXPORT_DIR_REL}/{LINT_META_SUBDIR}/{REGISTRY_BASENAME}")
}

/// The bundle plan: every staged path, in write order, paired with its content source.
/// The lint-meta payload is present only when the project has applied rules — an empty
/// registry would be a CI that imports fine and enforces nothing.
fn bundle_plan(rules: &[ExportedRule]) -> Vec<(String, BundleFile)> {
    let mut plan = vec![
        (
            format!("{EXPORT_DIR_REL}/{MANIFEST_BASENAME}"),
            BundleFile::Manifest,
        ),
        (
            format!("{EXPORT_DIR_REL}/{WORKFLOW_BASENAME}"),
            BundleFile::Workflow,
        ),
        (
            format!("{EXPORT_DIR_REL}/{README_BASENAME}"),
            BundleFile::Readme,
        ),
    ];
    if rules.is_empty() {
        return plan;
    }
    let lint_meta_dir = format!("{EXPORT_DIR_REL}/{LINT_META_SUBDIR}");
    plan.push((registry_rel(), BundleFile::Registry));
    for (i, rule) in rules.iter().enumerate() {
        plan.push((
            format!("{lint_meta_dir}/{RULES_SUBDIR}/{}", rule.file_name),
            BundleFile::Rule(i),
        ));
    }
    plan
}

/// The result of a portable-lock export — the staging path, the files written, the
/// workflow YAML (so the UI can offer a copy button), and the pinned runner version.
/// Rust-authored ts-rs boundary type (registered in `bindings/export.rs`); web-facing
/// only, so it derives `Serialize` (never deserialized back).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PortableLockExport.ts"))]
pub struct PortableLockExport {
    /// Absolute path to the staging dir (`<project>/.nightcore/export/portable-lock`).
    pub staging_dir: String,
    /// The project-relative paths written (`harness.json`, `nightcore-lock.yml`,
    /// `README.md`), in write order.
    pub files_written: Vec<String>,
    /// The exact `nightcore-lock.yml` text — offered with a copy button so the user
    /// can drop it into `.github/workflows/` (the ONE manual step).
    pub workflow_yaml: String,
    /// The pinned runner version the workflow invokes
    /// ([`PORTABLE_LOCK_RUNNER_VERSION`]).
    pub runner_version: String,
}

/// The deterministic `nightcore-lock.yml` GitHub Actions workflow (spec §3.4). The
/// runner is invoked by its PUBLISHED name `@noctcore/harness` (the `@noctcore` org
/// PR 4 publishes to), pinned to [`PORTABLE_LOCK_RUNNER_VERSION`] — never `@latest`.
/// Action majors are pinned to non-deprecated versions (`reference_ci_node20_deprecation`):
/// `checkout` matches this repo's own workflows (`@v7`); `setup-node@v5` is the current
/// non-deprecated major (the repo itself uses `oven-sh/setup-bun`, so there is no
/// in-repo `setup-node` pin to match). Node 22 = the runner floor + the repo floor.
fn workflow_yaml() -> String {
    format!(
        "# Generated by Nightcore — portable Structure-Lock. Commit into .github/workflows/.\n\
name: structure-lock\n\
on: [push, pull_request]\n\
jobs:\n\
  structure-lock:\n\
    runs-on: ubuntu-latest\n\
    steps:\n\
      - uses: actions/checkout@v7\n\
      - uses: actions/setup-node@v5\n\
        # '22' resolves to the latest 22.x, which strips TypeScript types natively\n\
        # (>= 22.18) — what loading the lint-meta rule registry needs.\n\
        with: {{ node-version: '22' }}\n\
      # PINNED runner version (§5 supply-chain) — matches the published runner.\n\
      # --manifest: CI reads the BUNDLE's manifest (its lint-meta checks are translated\n\
      # to the portable runner), never the live .nightcore/harness.json.\n\
      - run: npx --yes @noctcore/harness@{version} check --manifest {manifest}\n",
        version = PORTABLE_LOCK_RUNNER_VERSION,
        manifest = format_args!("{EXPORT_DIR_REL}/{MANIFEST_BASENAME}"),
    )
}

/// The bundle README's lint-meta section — deterministic in the rule set and in how
/// many `lint-meta` checks were translated. When checks were translated but no rules
/// travel, it says so PLAINLY: those checks will red the build. That is the honest
/// outcome (the bundle cannot enforce rules it does not carry); the alternative —
/// quietly dropping or disabling the check — is a lock that passes while enforcing
/// nothing, which is the failure this whole feature exists to prevent.
fn readme_lint_meta_section(rules: &[ExportedRule], translated: usize) -> String {
    if rules.is_empty() {
        if translated == 0 {
            return String::new();
        }
        return format!(
            "- `lint-meta/` — **not exported**: this project has no APPLIED `lint-meta-rule`\n\
  artifacts, so there are no portable rules to ship. The {translated} translated `lint-meta`\n\
  check(s) above will therefore FAIL until you apply the generated rules in Nightcore and\n\
  re-export. A failing check is the honest state — a passing one would mean CI enforcing\n\
  nothing.\n"
        );
    }

    let mut listed = String::new();
    for rule in rules {
        listed.push_str(&format!(
            "  - `{LINT_META_SUBDIR}/{RULES_SUBDIR}/{}` — copied from `{}`\n",
            rule.file_name, rule.source_rel
        ));
    }
    format!(
        "- `{LINT_META_SUBDIR}/` — the portable lint-meta rules this bundle enforces plus the\n\
  generated `{REGISTRY_BASENAME}` the runner imports (the ONLY module it loads). The rules\n\
  are copied VERBATIM and stay TypeScript — the runner strips their types (Node >= 22.18).\n\
  Only their extension is pinned to `.mts`, so they load as ES modules whatever this\n\
  repo's `package.json` says.\n\
{listed}"
    )
}

/// The deterministic bundle `README.md`: what the bundle is, the ONE manual step, how
/// to run locally, and the honest downstream-owned caveat (spec §5).
fn readme_markdown(rules: &[ExportedRule], translated: usize) -> String {
    format!(
        "# Portable Structure-Lock\n\
\n\
This bundle lets your CI enforce this repo's Structure-Lock **without Nightcore** — no\n\
server, no account, no install beyond a single `npx` runner.\n\
\n\
## What's here\n\
\n\
- `harness.json` — the checks + policy CI runs: a copy of `.nightcore/harness.json`,\n\
  stamped with a `schemaVersion` so the runner can read it forward-compatibly. This copy\n\
  is the ONE manifest CI reads, and its `lint-meta` checks are rewritten to run through\n\
  the published runner — so nothing here needs your package manager or your installed\n\
  dependencies. Your live `.nightcore/harness.json` is left alone.\n\
- `nightcore-lock.yml` — a ready-to-commit GitHub Actions workflow that runs\n\
  `npx @noctcore/harness@{version} check --manifest {manifest}` on every push and pull\n\
  request.\n\
{lint_meta}\
\n\
## Install (ONE manual step)\n\
\n\
The workflow is **staged here, not auto-installed** — a CI workflow must be committed\n\
by a human, never placed by a tool. Copy it into your workflows directory and commit it\n\
together with this whole bundle (CI reads the bundle, so it must be committed):\n\
\n\
```sh\n\
mkdir -p .github/workflows\n\
cp {export_dir}/{workflow} .github/workflows/{workflow}\n\
git add .github/workflows/{workflow} {export_dir}\n\
git commit -m \"ci: enforce portable Structure-Lock\"\n\
```\n\
\n\
Once committed, the check reds the build on any Structure-Lock violation — governing\n\
teammates who never open Nightcore. Re-exporting rewrites ONLY this directory (review it\n\
as a `git diff`); if `{workflow}` changed, copy it across again.\n\
\n\
## Run it locally\n\
\n\
```sh\n\
npx --yes @noctcore/harness@{version} check --manifest {manifest}\n\
```\n\
\n\
Requires Node >= 22 (>= 22.18 to load the TypeScript rule registry).\n\
\n\
## Note on trust\n\
\n\
The runner enforces **whatever is present** in this repo. It is NOT an integrity check:\n\
it does not verify that the committed rules match what Nightcore originally generated. If\n\
someone weakens a rule or deletes a check, the runner enforces the weakened set. The\n\
control against silent weakening is **PR review of the diff** — a re-export produces a\n\
reviewable `git diff`, not a silent overwrite.\n\
\n\
`{REGISTRY_BASENAME}` alone decides which rules run: a rule file left behind after it\n\
stops being exported is never imported (delete it at your leisure), and a rule the\n\
registry names but that fails to load reds the build rather than being skipped.\n",
        version = PORTABLE_LOCK_RUNNER_VERSION,
        manifest = format_args!("{EXPORT_DIR_REL}/{MANIFEST_BASENAME}"),
        export_dir = EXPORT_DIR_REL,
        workflow = WORKFLOW_BASENAME,
        lint_meta = readme_lint_meta_section(rules, translated),
    )
}

/// Re-assert, in the instant BEFORE the write syscall, that `dest`'s parent still
/// canonicalizes to inside `root` and that the leaf is not a symlink. Mirrors
/// `apply.rs::revalidate_parent_contained` (kept LOCAL — `apply.rs` is frozen and its
/// helper is private) to narrow the mid-path-symlink-swap TOCTOU window that
/// [`safe_join`]'s lstat walk alone leaves open. The atomic temp+rename below also
/// REPLACES a destination symlink rather than following it.
fn revalidate_parent_contained(root: &Path, dest: &Path) -> Result<(), String> {
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("project root {} is not accessible: {e}", root.display()))?;
    let parent = dest
        .parent()
        .ok_or_else(|| "export path has no parent directory".to_string())?;
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("cannot resolve {} before write: {e}", parent.display()))?;
    if parent_canon != root_canon && !parent_canon.starts_with(&root_canon) {
        return Err(format!(
            "export parent resolved outside the project root just before write: {}",
            dest.display()
        ));
    }
    if let Ok(meta) = std::fs::symlink_metadata(dest) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "export target became a symlink before write (rejected): {}",
                dest.display()
            ));
        }
    }
    Ok(())
}

/// Write one staged bundle file, OVERWRITING any prior copy (re-export is idempotent
/// and reviewable via `git diff` — decision 4). Creates the staging dir, re-validates
/// containment immediately before the write, then writes atomically (temp + rename).
fn write_staged(root: &Path, dest: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    revalidate_parent_contained(root, dest)?;
    crate::store::write_atomic(dest, content.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", dest.display()))
}

/// Stage the portable-lock bundle for `project_path` and return its descriptor.
///
/// Order matters for containment: every bundle destination is resolved through
/// [`safe_join`] FIRST (rejecting a symlinked `.nightcore` escaping the root, mirroring
/// `write_merge_manifest`'s test), so a rejection short-circuits BEFORE the live-manifest
/// stamp or any bundle write can follow the symlink out of the repo. Then the live
/// `.nightcore/harness.json` is stamped with `schemaVersion` (additive, idempotent —
/// [`stamp_live_manifest`]) and its stamped text — with the bundle copy's `lint-meta`
/// commands translated to the published runner — becomes the bundle's `harness.json`.
/// Finally the deterministic workflow + README and the lint-meta payload are staged.
pub(in crate::sidecar::harness) fn write_portable_lock(
    project_path: &str,
) -> Result<PortableLockExport, String> {
    let root = Path::new(project_path);

    // READ-ONLY first: which applied lint-meta rules travel (each read through
    // `safe_join`). This decides the bundle's shape, so it precedes the containment
    // gate below — it writes nothing, and a containment failure still short-circuits
    // before the stamp.
    let rules = lint_meta::collect_applied_rules(root);
    let plan = bundle_plan(&rules);

    // Containment gate: resolve every destination through the shared safe_join. A
    // symlinked `.nightcore` (escaping or in-root) is rejected here, before any write.
    let dests: Vec<(String, PathBuf, &BundleFile)> = plan
        .iter()
        .map(|(rel, which)| safe_join(root, rel).map(|dest| (rel.clone(), dest, which)))
        .collect::<Result<_, _>>()?;

    // Stamp the live manifest (additive, idempotent) — the ONLY thing the export does to
    // it — then translate the bundle COPY's lint-meta commands to the portable runner.
    let stamped = stamp_live_manifest(project_path)?;
    let (manifest_json, translated) = lint_meta::translate_lint_meta_commands(
        &stamped,
        &lint_meta::lint_meta_command(PORTABLE_LOCK_RUNNER_VERSION, &registry_rel()),
    )?;
    let workflow = workflow_yaml();
    let readme = readme_markdown(&rules, translated);
    let registry = lint_meta::registry_source(&rules);

    let content_for = |which: &BundleFile| -> &str {
        match which {
            BundleFile::Manifest => manifest_json.as_str(),
            BundleFile::Workflow => workflow.as_str(),
            BundleFile::Readme => readme.as_str(),
            BundleFile::Registry => registry.as_str(),
            BundleFile::Rule(i) => rules[*i].content.as_str(),
        }
    };

    let mut files_written = Vec::with_capacity(dests.len());
    let mut staging_dir: Option<PathBuf> = None;
    for (rel, dest, which) in &dests {
        write_staged(root, dest, content_for(which))?;
        if staging_dir.is_none() {
            staging_dir = dest.parent().map(Path::to_path_buf);
        }
        files_written.push(rel.clone());
    }

    let staging = staging_dir.ok_or("could not resolve the export staging dir")?;
    Ok(PortableLockExport {
        staging_dir: staging.to_string_lossy().into_owned(),
        files_written,
        workflow_yaml: workflow,
        runner_version: PORTABLE_LOCK_RUNNER_VERSION.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tempfile::TempDir;

    fn seed_manifest(tmp: &TempDir, content: &str) {
        let dir = tmp.path().join(".nightcore");
        std::fs::create_dir_all(&dir).expect("create .nightcore");
        std::fs::write(dir.join("harness.json"), content).expect("write manifest");
    }

    fn staging(tmp: &TempDir) -> PathBuf {
        tmp.path().join(".nightcore/export/portable-lock")
    }

    /// The repo-relative path an applied fixture rule lives at, and the committed
    /// fixture directory both languages read (see `fixture` below).
    const FIXTURE_RULE_REL: &str = "tools/lint-meta/rules/no-todo-comments.ts";
    const FIXTURE_DIR: &str = "packages/harness/fixtures/portable-lock";

    /// Read a committed cross-language fixture. These files are the CONTRACT between the
    /// Rust exporter (which emits them) and the runner's Node e2e (which loads them and
    /// proves they catch a violation) — one committed artifact instead of two copies
    /// "kept in lockstep" by a comment.
    fn fixture(name: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join(FIXTURE_DIR)
            .join(name);
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read fixture {}: {e}", path.display()))
    }

    /// Seed the project with ONE applied `lint-meta-rule` artifact whose file is the
    /// committed fixture rule — the same input the runner's e2e enforces with.
    fn seed_applied_fixture_rule(tmp: &TempDir) -> String {
        let body = fixture("no-todo-comments.rule.ts.txt");
        let rule_path = tmp.path().join(FIXTURE_RULE_REL);
        std::fs::create_dir_all(rule_path.parent().unwrap()).expect("create rule dir");
        std::fs::write(&rule_path, &body).expect("write rule");

        let runs = tmp.path().join(".nightcore/harness");
        std::fs::create_dir_all(&runs).expect("create scan dir");
        let run = serde_json::json!({
            "id": "run-1",
            "artifacts": [{
                "id": "a1",
                "kind": "lint-meta-rule",
                "status": "applied",
                "appliedPath": FIXTURE_RULE_REL,
            }],
        });
        std::fs::write(runs.join("run-1.json"), run.to_string()).expect("write run");
        body
    }

    #[test]
    fn stages_the_bundle_with_a_stamped_manifest_copy() {
        // The bundle lands under `.nightcore/export/portable-lock/`; `harness.json` is a
        // `schemaVersion`-stamped copy of the live manifest that preserves its checks.
        let tmp = TempDir::new().unwrap();
        seed_manifest(
            &tmp,
            r#"{ "checks": [ { "name": "folder", "kind": "lint-plugin", "command": "npx eslint ." } ] }"#,
        );

        let out = write_portable_lock(&tmp.path().to_string_lossy()).unwrap();

        for name in [MANIFEST_BASENAME, WORKFLOW_BASENAME, README_BASENAME] {
            assert!(
                staging(&tmp).join(name).exists(),
                "expected staged file {name}"
            );
        }

        let manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(staging(&tmp).join("harness.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["schemaVersion"], 1, "bundle manifest is stamped");
        assert_eq!(
            manifest["checks"][0]["name"], "folder",
            "the armed check travels in the bundle"
        );

        // The live manifest is stamped too (so a re-export is idempotent on it).
        let live: Value = serde_json::from_str(
            &std::fs::read_to_string(tmp.path().join(".nightcore/harness.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(live["schemaVersion"], 1);
        assert_eq!(live["checks"][0]["name"], "folder");

        // Result descriptor. Only the three base files: no applied lint-meta rules ⇒ no
        // lint-meta payload (an empty registry would be CI enforcing nothing).
        assert_eq!(out.runner_version, PORTABLE_LOCK_RUNNER_VERSION);
        assert_eq!(out.files_written.len(), 3);
        assert!(!staging(&tmp).join(LINT_META_SUBDIR).exists());
        assert!(out.staging_dir.ends_with(".nightcore/export/portable-lock"));
    }

    #[test]
    fn workflow_is_deterministic_and_pins_the_published_runner() {
        // The staged YAML is a deterministic template that names the PUBLISHED package
        // `@noctcore/harness` pinned to the runner version — never `@latest`.
        let tmp = TempDir::new().unwrap();
        let out = write_portable_lock(&tmp.path().to_string_lossy()).unwrap();

        let yaml = std::fs::read_to_string(staging(&tmp).join("nightcore-lock.yml")).unwrap();
        assert_eq!(yaml, out.workflow_yaml, "returned YAML == the staged file");
        assert!(yaml.contains("name: structure-lock"));
        assert!(
            yaml.contains(
                "npx --yes @noctcore/harness@0.2.0 check --manifest .nightcore/export/portable-lock/harness.json"
            ),
            "must invoke the PUBLISHED @noctcore/harness pinned to the runner version, \
             reading the BUNDLE's manifest — not the live one"
        );
        assert!(
            !yaml.contains("@latest") && !yaml.contains("@nightcore/harness"),
            "never @latest, never the internal @nightcore name"
        );
        // Non-deprecated action majors (reference_ci_node20_deprecation).
        assert!(yaml.contains("actions/checkout@v7"));
        assert!(yaml.contains("actions/setup-node@v5"));
        assert!(!yaml.contains("@v4"), "no deprecated Node-20 action pin");
    }

    #[test]
    fn never_writes_under_dot_github() {
        // The workflow is STAGED, never auto-written into the denied `.github/` sink.
        let tmp = TempDir::new().unwrap();
        write_portable_lock(&tmp.path().to_string_lossy()).unwrap();
        assert!(
            !tmp.path().join(".github").exists(),
            "the CI sink stays human-committed — the exporter never touches .github/"
        );
    }

    #[test]
    fn re_export_overwrites_the_staging_dir_idempotently() {
        // Re-export rewrites ONLY the staging dir, byte-identically (deterministic).
        let tmp = TempDir::new().unwrap();
        seed_manifest(
            &tmp,
            r#"{ "checks": [ { "name": "lint", "kind": "lint-plugin", "command": "npx eslint ." } ] }"#,
        );
        let first = write_portable_lock(&tmp.path().to_string_lossy()).unwrap();
        let yaml1 = std::fs::read_to_string(staging(&tmp).join("nightcore-lock.yml")).unwrap();
        let readme1 = std::fs::read_to_string(staging(&tmp).join("README.md")).unwrap();

        let second = write_portable_lock(&tmp.path().to_string_lossy()).unwrap();
        let yaml2 = std::fs::read_to_string(staging(&tmp).join("nightcore-lock.yml")).unwrap();
        let readme2 = std::fs::read_to_string(staging(&tmp).join("README.md")).unwrap();

        assert_eq!(yaml1, yaml2, "re-export is byte-identical");
        assert_eq!(readme1, readme2);
        assert_eq!(first.files_written, second.files_written);
    }

    #[test]
    fn exports_even_when_no_manifest_exists_yet() {
        // No armed checks: the export still produces a valid v1 bundle (the runner then
        // finds no checks ⇒ exit 0). It must not hard-fail.
        let tmp = TempDir::new().unwrap();
        let out = write_portable_lock(&tmp.path().to_string_lossy()).unwrap();
        let manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(staging(&tmp).join("harness.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["schemaVersion"], 1);
        assert_eq!(out.files_written.len(), 3);
    }

    #[test]
    fn refuses_a_malformed_live_manifest() {
        // The stamp step errors on a malformed manifest (never reset it into the bundle),
        // and the broken file is preserved.
        let tmp = TempDir::new().unwrap();
        seed_manifest(&tmp, "{ not json");
        assert!(write_portable_lock(&tmp.path().to_string_lossy()).is_err());
        let raw = std::fs::read_to_string(tmp.path().join(".nightcore/harness.json")).unwrap();
        assert_eq!(raw, "{ not json", "the broken manifest is preserved");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_nightcore_escaping_the_root() {
        // Defence in depth, cloned from `write_merge_manifest_rejects_a_symlinked_manifest_
        // escaping_the_root` (apply.rs): a scanned repo shipping `.nightcore` as a symlink
        // to an outside dir must not let the export escape the project root — and the
        // containment gate must fire BEFORE the live-manifest stamp writes anything.
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join(".nightcore")).unwrap();

        assert!(
            write_portable_lock(&root.path().to_string_lossy()).is_err(),
            "a symlinked .nightcore escaping the root must be rejected"
        );
        assert!(
            !outside.path().join("harness.json").exists(),
            "the live-manifest stamp must not follow the symlink out of the root"
        );
        assert!(
            !outside.path().join("export").exists(),
            "no bundle written outside the root"
        );
    }

    #[test]
    fn exports_the_applied_lint_meta_rules_and_wires_the_check_to_them() {
        // The whole lint-meta half in one pass: the applied rule travels VERBATIM, the
        // registry + module-scope marker are emitted beside it, and the bundle manifest's
        // lint-meta command is translated to the published runner pointed at that registry.
        let tmp = TempDir::new().unwrap();
        seed_manifest(
            &tmp,
            r#"{ "checks": [
                { "name": "no-todo-comments", "kind": "lint-meta", "command": "bun run lint:meta" },
                { "name": "eslint", "kind": "lint-plugin", "command": "npx eslint ." }
            ] }"#,
        );
        let rule_body = seed_applied_fixture_rule(&tmp);

        let out = write_portable_lock(&tmp.path().to_string_lossy()).unwrap();

        // The rule is a BYTE-FOR-BYTE copy (no transpile ever happens in Rust); only the
        // extension is pinned to the unconditionally-ESM `.mts`.
        let copied =
            std::fs::read_to_string(staging(&tmp).join("lint-meta/rules/no-todo-comments.mts"))
                .unwrap();
        assert_eq!(
            copied, rule_body,
            "rules are copied verbatim, never rewritten"
        );
        assert!(
            !staging(&tmp).join("lint-meta/package.json").exists(),
            "package.json is a protected execution sink — the bundle scopes modules by \
             extension instead"
        );

        // The registry enumerates it.
        let registry =
            std::fs::read_to_string(staging(&tmp).join("lint-meta/registry.mts")).unwrap();
        assert!(registry.contains("import * as rule0 from './rules/no-todo-comments.mts';"));

        // The bundle manifest runs the PUBLISHED runner against that registry; the live
        // manifest keeps the package-script form the arm gate requires.
        let bundle: Value = serde_json::from_str(
            &std::fs::read_to_string(staging(&tmp).join("harness.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            bundle["checks"][0]["command"],
            "npx --yes @noctcore/harness@0.2.0 lint-meta --registry .nightcore/export/portable-lock/lint-meta/registry.mts"
        );
        assert_eq!(bundle["checks"][1]["command"], "npx eslint .");
        let live: Value = serde_json::from_str(
            &std::fs::read_to_string(tmp.path().join(".nightcore/harness.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            live["checks"][0]["command"], "bun run lint:meta",
            "the LIVE manifest is never command-rewritten (the arm gate rejects npx)"
        );

        // …and every staged path is reported, in write order.
        assert_eq!(
            out.files_written,
            vec![
                ".nightcore/export/portable-lock/harness.json",
                ".nightcore/export/portable-lock/nightcore-lock.yml",
                ".nightcore/export/portable-lock/README.md",
                ".nightcore/export/portable-lock/lint-meta/registry.mts",
                ".nightcore/export/portable-lock/lint-meta/rules/no-todo-comments.mts",
            ]
        );
        // The README tells the reviewer which rules travel and where they came from.
        let readme = std::fs::read_to_string(staging(&tmp).join("README.md")).unwrap();
        assert!(readme.contains("lint-meta/rules/no-todo-comments.mts"));
        assert!(readme.contains(FIXTURE_RULE_REL));
    }

    #[test]
    fn the_emitted_bundle_matches_the_committed_runner_fixtures() {
        // CROSS-LANGUAGE PARITY. `packages/harness/fixtures/portable-lock/*.txt` are the
        // exact bytes this exporter emits, and the runner's Node e2e drives the REAL CLI
        // against those same files to prove they catch a violation. Pinning them here
        // means the "the exported CI really enforces" proof can never drift from what the
        // exporter actually writes.
        //
        // Changed a template? Re-run this test with NIGHTCORE_UPDATE_GOLDEN=1 to rewrite
        // the fixtures, then review the diff and re-run the Node e2e (`bun test
        // packages/harness`).
        let tmp = TempDir::new().unwrap();
        seed_manifest(
            &tmp,
            r#"{ "checks": [ { "name": "no-todo-comments", "kind": "lint-meta", "command": "bun run lint:meta" } ] }"#,
        );
        seed_applied_fixture_rule(&tmp);
        write_portable_lock(&tmp.path().to_string_lossy()).unwrap();

        for (staged, golden) in [
            ("lint-meta/registry.mts", "registry.mts.txt"),
            ("harness.json", "harness.json.txt"),
        ] {
            let emitted = std::fs::read_to_string(staging(&tmp).join(staged)).unwrap();
            if std::env::var_os("NIGHTCORE_UPDATE_GOLDEN").is_some() {
                let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../..")
                    .join(FIXTURE_DIR)
                    .join(golden);
                std::fs::write(&path, &emitted).expect("update golden");
            }
            assert_eq!(
                emitted,
                fixture(golden),
                "the emitted {staged} drifted from the fixture the runner e2e enforces \
                 with; re-run with NIGHTCORE_UPDATE_GOLDEN=1 and review the diff"
            );
        }
    }

    #[test]
    fn a_lint_meta_check_with_no_exportable_rules_is_translated_and_says_so() {
        // A lint-meta check whose rules are NOT applied artifacts cannot be enforced
        // portably. The command is still translated (so CI fails loudly) rather than
        // dropped or left running a package script no bare CI checkout can execute —
        // and the README says exactly why, instead of the lock quietly passing.
        let tmp = TempDir::new().unwrap();
        seed_manifest(
            &tmp,
            r#"{ "checks": [ { "name": "own-engine", "kind": "lint-meta", "command": "bun run lint:meta" } ] }"#,
        );

        let out = write_portable_lock(&tmp.path().to_string_lossy()).unwrap();
        assert_eq!(out.files_written.len(), 3, "no registry for zero rules");

        let bundle: Value = serde_json::from_str(
            &std::fs::read_to_string(staging(&tmp).join("harness.json")).unwrap(),
        )
        .unwrap();
        assert!(bundle["checks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("@noctcore/harness@0.2.0 lint-meta --registry"));

        let readme = std::fs::read_to_string(staging(&tmp).join("README.md")).unwrap();
        assert!(readme.contains("not exported"));
        assert!(readme.contains("will therefore FAIL"));
    }

    #[test]
    fn re_exporting_a_lint_meta_bundle_is_byte_identical() {
        // The whole bundle — payload included — is deterministic, so a re-export is a
        // reviewable no-op diff rather than churn.
        let tmp = TempDir::new().unwrap();
        seed_manifest(
            &tmp,
            r#"{ "checks": [ { "name": "r", "kind": "lint-meta", "command": "bun run lint:meta" } ] }"#,
        );
        seed_applied_fixture_rule(&tmp);

        let first = write_portable_lock(&tmp.path().to_string_lossy()).unwrap();
        let read_all = |out: &PortableLockExport| -> Vec<String> {
            out.files_written
                .iter()
                .map(|rel| std::fs::read_to_string(tmp.path().join(rel)).unwrap())
                .collect()
        };
        let before = read_all(&first);
        let second = write_portable_lock(&tmp.path().to_string_lossy()).unwrap();
        assert_eq!(first.files_written, second.files_written);
        assert_eq!(before, read_all(&second));
    }
}
