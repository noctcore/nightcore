//! The plugin-wired preflight for arming a `lint-plugin` gauntlet check (T7).
//!
//! The placebo-gate bug: applying a generated ESLint plugin FILE writes the plugin
//! but does NOT wire it into the project's `eslint.config.*` (that is a separate,
//! human-reviewed `agent-task`). So a user could apply the plugin, arm
//! `npx eslint .`, and get a GREEN check that enforces nothing — the plugin's rules
//! are never loaded. This module verifies, at arm time, that the plugin the user is
//! arming a check FOR is actually referenced by an ESLint config, and refuses the
//! arm (fail-closed) otherwise so the gate can never be a placebo.
//!
//! It is a positive-signal check keyed on the APPLIED artifact's path (`require_wired`
//! on the arm command) — so it only fires on the exact "apply-then-arm" trap it
//! guards, never on a hand-authored command with no plugin identity. Pure detection
//! (over collected config text) so it is unit-testable without a filesystem; the
//! thin collector reads the config files.

use std::path::Path;

/// ESLint flat-config filenames (the modern `eslint.config.*` family).
const ESLINT_FLAT_CONFIGS: &[&str] = &[
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    "eslint.config.mts",
    "eslint.config.cts",
];

/// Legacy `.eslintrc*` config filenames (still resolved by ESLint).
const ESLINT_LEGACY_CONFIGS: &[&str] = &[
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml",
];

/// True if `basename` names an ESLint config file (flat or legacy).
fn is_eslint_config_name(basename: &str) -> bool {
    ESLINT_FLAT_CONFIGS.contains(&basename) || ESLINT_LEGACY_CONFIGS.contains(&basename)
}

/// The `(name, contents)` of every ESLint config found at the project root and one
/// level down under `packages/*` and `apps/*` (the common monorepo layouts) — a
/// bounded scan, never a full-tree walk. A config that can't be read is skipped.
fn collect_eslint_configs(project_path: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut scan_dir = |dir: &Path| {
        for name in ESLINT_FLAT_CONFIGS.iter().chain(ESLINT_LEGACY_CONFIGS) {
            let path = dir.join(name);
            if let Ok(contents) = std::fs::read_to_string(&path) {
                out.push((name.to_string(), contents));
            }
        }
    };
    scan_dir(project_path);
    for parent in ["packages", "apps"] {
        let base = project_path.join(parent);
        let Ok(entries) = std::fs::read_dir(&base) else {
            continue;
        };
        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_dir() {
                scan_dir(&child);
            }
        }
    }
    out
}

/// Generic directory / file names that are too common to be a reliable reference
/// signal — matching a config against `src` or `index` would false-positive on
/// almost any config. A needle whose last segment is one of these is dropped.
const GENERIC_SEGMENTS: &[&str] = &[
    "src", "lib", "dist", "build", "out", "app", "apps", "packages", "test", "tests", "index",
    "main", "plugin", "plugins", "rules", "config", "eslint",
];

/// Normalize a repo-relative plugin path (backslashes → `/`, trimmed) and derive the
/// path forms an ESLint config would use to reference it. Only PATH-SHAPED needles
/// are used — the full path, the path without extension, and the parent directory —
/// because a bare basename like `index.js` or a generic dir like `src` appears in
/// nearly every config and would false-positive the gate. A needle whose final
/// segment is generic ([`GENERIC_SEGMENTS`]) or shorter than 3 chars is dropped, so
/// a match means the config genuinely names this plugin's location. Needles are
/// matched by path-segment SUFFIX (see [`literal_refers_to`]) against the config's
/// string literals, never by raw substring.
fn wiring_needles(plugin_rel_path: &str) -> Vec<String> {
    let norm = plugin_rel_path.replace('\\', "/");
    let norm = norm.trim_matches('/').trim().to_string();
    let mut needles: Vec<String> = Vec::new();

    /// Append `s` if it is ≥3 chars, unique, and (unless `always`) not a generic
    /// last segment that would false-match almost any config.
    fn push(needles: &mut Vec<String>, s: &str, always: bool) {
        let s = s.trim().trim_matches('/');
        if s.len() < 3 || needles.iter().any(|n| n == s) {
            return;
        }
        if !always {
            let last = s.rsplit('/').next().unwrap_or(s);
            let last_stem = last.split('.').next().unwrap_or(last);
            if GENERIC_SEGMENTS.contains(&last) || GENERIC_SEGMENTS.contains(&last_stem) {
                return;
            }
        }
        needles.push(s.to_string());
    }

    // The full path is always specific enough to keep even if its basename is
    // generic (e.g. `tools/eslint-rules/index.js`).
    push(&mut needles, &norm, true);
    // Path without a trailing file extension (`tools/eslint-rules/index`) — also
    // always kept, so an `import '.../index'` (no `.js`) still matches.
    if let Some(dot) = norm.rfind('.') {
        if norm[dot..].find('/').is_none() {
            push(&mut needles, &norm[..dot], true);
        }
    }
    // The parent directory — a local plugin is often imported by its dir
    // (`import x from './tools/eslint-rules'`) — but only when it is NOT generic.
    if let Some(slash) = norm.rfind('/') {
        push(&mut needles, &norm[..slash], false);
    } else {
        // A depth-1 plugin file (`my-plugin.js`): its basename is the only identity.
        push(&mut needles, &norm, false);
    }
    needles
}

/// Extract the contents of every string literal in `text` (single-, double-, or
/// backtick-quoted), skipping anything inside `//` line comments and `/* … */`
/// block comments. A tiny hand-rolled scanner: an ESLint config references a local
/// plugin ONLY as a quoted module specifier (`import … from '<path>'` /
/// `require('<path>')`), so matching against the extracted literals — never the raw
/// text — is what makes the gate robust. A path mentioned in a COMMENT, or that is
/// merely a substring of a longer sibling path, is no longer a false "wired" signal.
fn string_literals(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            // `//` line comment: skip to end of line.
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            // `/* … */` block comment: skip to the closing `*/`.
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            // A string literal: capture its contents up to the matching close quote
            // (a `\` escapes the next byte, so `\'` does not end a single-quoted one).
            quote @ (b'\'' | b'"' | b'`') => {
                i += 1;
                let start = i;
                while i < bytes.len() && bytes[i] != quote {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                let end = i.min(bytes.len());
                if let Ok(s) = std::str::from_utf8(&bytes[start..end]) {
                    out.push(s.to_string());
                }
                i += 1; // step past the closing quote
            }
            _ => i += 1,
        }
    }
    out
}

/// True if the module specifier `literal` refers to the path `needle` by path-segment
/// SUFFIX — an exact match or a `/`-anchored tail. So a sibling `…/bar.js` never
/// matches a plugin `…/foo.js`, while a nested config's `../../tools/eslint-rules`
/// still resolves to the root plugin. A glob pattern (an `ignores`/`files` entry,
/// which contains `*`) is never a module specifier, so it can wire nothing.
fn literal_refers_to(literal: &str, needle: &str) -> bool {
    let lit = literal.replace('\\', "/");
    let lit = lit.trim().trim_end_matches('/');
    if lit.contains('*') {
        return false;
    }
    lit == needle || lit.ends_with(&format!("/{needle}"))
}

/// True if any collected config REGISTERS the plugin: some string-literal module
/// specifier in it (comments and glob patterns excluded) resolves — by path suffix —
/// to one of the plugin's [`wiring_needles`].
fn any_config_references(configs: &[(String, String)], needles: &[String]) -> bool {
    configs.iter().any(|(_, text)| {
        let literals = string_literals(text);
        literals
            .iter()
            .any(|lit| needles.iter().any(|n| literal_refers_to(lit, n)))
    })
}

/// Pure assessment: given the ESLint configs found and the applied plugin's
/// repo-relative path, decide whether the plugin is wired. `Ok(())` when it IS (an
/// eslint config references it — or the applied artifact IS itself an eslint
/// config); `Err(reason)` when arming would be a placebo. Kept filesystem-free for
/// tests; [`assert_plugin_wired`] is the thin production wrapper.
fn assess_plugin_wiring(configs: &[(String, String)], plugin_rel_path: &str) -> Result<(), String> {
    let norm = plugin_rel_path.replace('\\', "/");
    let basename = norm.trim_matches('/').rsplit('/').next().unwrap_or("");
    // Arming from an applied ESLint CONFIG artifact: the config IS the wiring.
    if is_eslint_config_name(basename) {
        return Ok(());
    }
    if configs.is_empty() {
        return Err(format!(
            "no ESLint config (`eslint.config.*` / `.eslintrc*`) found in this project, so \
             the generated plugin at `{plugin_rel_path}` enforces nothing — arming this check \
             would be a placebo gate. Wire the plugin into an ESLint config first (the \
             \"wire the plugin\" agent task), then arm the check."
        ));
    }
    let needles = wiring_needles(plugin_rel_path);
    if any_config_references(configs, &needles) {
        return Ok(());
    }
    Err(format!(
        "the generated plugin at `{plugin_rel_path}` isn't referenced by any ESLint config yet, \
         so `npx eslint .` would run WITHOUT it — arming this check would be a placebo gate. \
         Wire the plugin into your `eslint.config.*` first, then arm the check."
    ))
}

/// Production entry point: refuse to arm a `lint-plugin` check for `plugin_rel_path`
/// unless it is actually wired into an ESLint config under `project_path`. Reads the
/// bounded config set, then delegates to [`assess_plugin_wiring`].
pub(super) fn assert_plugin_wired(
    project_path: &Path,
    plugin_rel_path: &str,
) -> Result<(), String> {
    let configs = collect_eslint_configs(project_path);
    assess_plugin_wiring(&configs, plugin_rel_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wiring_needles_are_path_specific_not_generic() {
        let needles = wiring_needles("tools/eslint-rules/index.js");
        // Path-shaped, specific forms are kept.
        for expected in [
            "tools/eslint-rules/index.js",
            "tools/eslint-rules/index",
            "tools/eslint-rules",
        ] {
            assert!(
                needles.iter().any(|n| n == expected),
                "expected needle {expected:?} in {needles:?}"
            );
        }
        // Bare generic segments are NOT needles (they'd match almost any config).
        for generic in ["index", "index.js", "eslint-rules", "js"] {
            assert!(
                !needles.iter().any(|n| n == generic),
                "generic needle {generic:?} must be dropped: {needles:?}"
            );
        }
    }

    #[test]
    fn a_generic_parent_dir_is_not_a_needle() {
        // `src` is too common to be a reliable reference — only the full path forms
        // survive, so a plugin under `src/` matches a config that names the file, not
        // one that merely mentions `src`.
        let needles = wiring_needles("src/index.js");
        assert!(needles.iter().any(|n| n == "src/index.js"));
        assert!(
            !needles.iter().any(|n| n == "src"),
            "generic `src` dropped: {needles:?}"
        );
    }

    #[test]
    fn an_applied_eslint_config_is_inherently_wired() {
        // Arming from an applied `eslint.config.mjs` artifact needs no reference check.
        assert!(assess_plugin_wiring(&[], "eslint.config.mjs").is_ok());
        assert!(assess_plugin_wiring(&[], "apps/web/eslint.config.ts").is_ok());
    }

    #[test]
    fn no_config_at_all_is_a_placebo() {
        let err = assess_plugin_wiring(&[], "tools/eslint-rules/index.js")
            .expect_err("no config ⇒ placebo");
        assert!(err.contains("no ESLint config"), "got: {err}");
    }

    #[test]
    fn a_config_that_references_the_plugin_is_wired() {
        let configs = vec![(
            "eslint.config.mjs".to_string(),
            "import local from './tools/eslint-rules/index.js';\nexport default [local];"
                .to_string(),
        )];
        assert!(assess_plugin_wiring(&configs, "tools/eslint-rules/index.js").is_ok());
    }

    #[test]
    fn a_config_referencing_the_plugin_dir_counts_as_wired() {
        let configs = vec![(
            "eslint.config.mjs".to_string(),
            "import pkg from './tools/eslint-rules';\nexport default [pkg];".to_string(),
        )];
        assert!(assess_plugin_wiring(&configs, "tools/eslint-rules/index.js").is_ok());
    }

    #[test]
    fn a_config_that_does_not_reference_the_plugin_is_a_placebo() {
        // The repo has an ESLint config, but it never wires the new plugin in.
        let configs = vec![(
            "eslint.config.mjs".to_string(),
            "import js from '@eslint/js';\nexport default [js.configs.recommended];".to_string(),
        )];
        let err = assess_plugin_wiring(&configs, "tools/eslint-rules/index.js")
            .expect_err("unreferenced plugin ⇒ placebo");
        assert!(err.contains("isn't referenced"), "got: {err}");
    }

    #[test]
    fn collect_finds_root_and_package_configs() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(tmp.path().join("eslint.config.mjs"), "export default [];").expect("root");
        let pkg = tmp.path().join("packages/web");
        std::fs::create_dir_all(&pkg).expect("mkdir pkg");
        std::fs::write(pkg.join("eslint.config.ts"), "export default [];").expect("pkg config");
        let configs = collect_eslint_configs(tmp.path());
        assert_eq!(configs.len(), 2, "root + one package config: {configs:?}");
    }

    #[test]
    fn assert_plugin_wired_reads_the_real_config() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        std::fs::write(
            tmp.path().join("eslint.config.mjs"),
            "import p from './tools/eslint-rules/index.js';\nexport default [p];",
        )
        .expect("config");
        assert!(assert_plugin_wired(tmp.path(), "tools/eslint-rules/index.js").is_ok());
        // A different, unwired plugin path is refused.
        assert!(assert_plugin_wired(tmp.path(), "other/plugin/index.js").is_err());
    }

    // --- Substring-defeat regressions (the arm-gate can no longer be tricked) ---

    #[test]
    fn a_sibling_plugin_in_the_same_dir_does_not_false_positive() {
        // The config wires a DIFFERENT plugin file in the SAME directory; the plugin
        // being armed is never registered, so arming its check is still a placebo.
        // The old substring gate matched the shared parent dir and armed green.
        let configs = vec![(
            "eslint.config.mjs".to_string(),
            "import sibling from './tools/eslint-rules/sibling.js';\nexport default [sibling];"
                .to_string(),
        )];
        let err = assess_plugin_wiring(&configs, "tools/eslint-rules/my-plugin.js")
            .expect_err("a sibling reference must not count as wiring this plugin");
        assert!(err.contains("isn't referenced"), "got: {err}");
    }

    #[test]
    fn a_path_only_in_a_comment_does_not_wire() {
        // Whether the plugin path is dropped in a line or a block comment, it is not
        // a registration — the config never actually loads the plugin.
        for body in [
            "// wire ./tools/eslint-rules/index.js once reviewed\nexport default [];",
            "/* wire ./tools/eslint-rules/index.js once reviewed */\nexport default [];",
        ] {
            let configs = vec![("eslint.config.mjs".to_string(), body.to_string())];
            let err = assess_plugin_wiring(&configs, "tools/eslint-rules/index.js")
                .expect_err("a commented path must not count as wiring");
            assert!(err.contains("isn't referenced"), "got: {err}");
        }
    }

    #[test]
    fn a_path_only_in_an_ignores_glob_does_not_wire() {
        // An `ignores` glob EXCLUDES files from linting — the opposite of wiring the
        // plugin in — so it must never satisfy the arm gate.
        let configs = vec![(
            "eslint.config.mjs".to_string(),
            "export default [{ ignores: ['tools/eslint-rules/**'] }];".to_string(),
        )];
        let err = assess_plugin_wiring(&configs, "tools/eslint-rules/index.js")
            .expect_err("an ignores glob must not count as wiring");
        assert!(err.contains("isn't referenced"), "got: {err}");
    }

    #[test]
    fn a_genuinely_wired_plugin_is_still_detected() {
        // The real registration path (import the local plugin, turn its rule on) is
        // still recognized — the hardening only removes false positives.
        let configs = vec![(
            "eslint.config.mjs".to_string(),
            "import local from './tools/eslint-rules/index.js';\n\
             export default [{ plugins: { local }, rules: { 'local/my-rule': 'error' } }];"
                .to_string(),
        )];
        assert!(assess_plugin_wiring(&configs, "tools/eslint-rules/index.js").is_ok());
    }

    #[test]
    fn a_nested_config_importing_via_a_parent_path_is_wired() {
        // A package-level config imports the root plugin via `../../`; the path suffix
        // still identifies it, so monorepo wiring keeps working precisely.
        let configs = vec![(
            "eslint.config.ts".to_string(),
            "import p from '../../tools/eslint-rules/index.js';\nexport default [p];".to_string(),
        )];
        assert!(assess_plugin_wiring(&configs, "tools/eslint-rules/index.js").is_ok());
    }

    #[test]
    fn string_literals_skips_comments_and_captures_quotes() {
        // The scanner ignores line + block comments and captures each quote style.
        let lits = string_literals(
            "// './commented.js'\nimport a from './real.js';\n/* './blocked.js' */\nconst b = `./tpl.js`;",
        );
        assert!(lits.iter().any(|l| l == "./real.js"), "{lits:?}");
        assert!(lits.iter().any(|l| l == "./tpl.js"), "{lits:?}");
        assert!(
            !lits
                .iter()
                .any(|l| l.contains("commented") || l.contains("blocked")),
            "commented literals are not captured: {lits:?}"
        );
    }
}
