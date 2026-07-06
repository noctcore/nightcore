//! Ranked repo map for the Pre-flight Context Pack (hardening module #14, prior
//! art: Aider's repomap). A deterministic, zero-token generator: tree-sitter
//! parses the project's git-tracked TS/TSX/JS/Rust sources, extracts each file's
//! top-level definition symbols plus its import edges, ranks files with PageRank
//! over the import graph, and renders a budgeted Markdown section that
//! [`crate::analysis::context::assemble_default`] appends to the pack.
//!
//! Design constraints:
//! - **Deterministic**: identical output for an unchanged tree. Files are sorted
//!   by path before any cap, graph indices are path-ordered, PageRank iterates in
//!   fixed order, and rank ties break by path. No HashMap iteration order ever
//!   reaches the output.
//! - **Budgeted**: the section never exceeds [`REPO_MAP_SECTION_MAX_LINES`]
//!   lines; overflow is elided with an explicit `… (N more files)` tail.
//! - **Fail-open to absence**: a non-git project, a git failure, or a tree with
//!   no parseable sources yields `None` — the pack simply omits the section.
//!
//! Pipeline stages, one per sibling: [`lang`] (language classification, the parse
//! budget, and the extracted-facts shapes + git file listing), [`parse`]
//! (tree-sitter symbol/import extraction), [`resolve`] (specifier → repo-relative
//! edge resolution), and [`render`] (PageRank + budgeted Markdown, the public
//! [`generate`] entry point).

mod lang;
mod parse;
mod render;
mod resolve;

pub use render::generate;
// The section budget is public API + the module-doc link target, but no in-crate
// caller references it through this facade (the cap is internal to `render`, and
// the tests reach it via `super::render`).
#[allow(unused_imports)]
pub use render::REPO_MAP_SECTION_MAX_LINES;

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::path::Path;

    use tempfile::TempDir;

    use super::lang::MAX_FILE_BYTES;
    use super::render::{generate, REPO_MAP_SECTION_MAX_LINES};
    use super::resolve::{expand_use_paths, resolve_rust_use, resolve_ts_import, rust_module_ctx};

    /// A git repo fixture: `write` files, then `commit` (add -A + commit) so
    /// `git ls-files` sees them. Mirrors the injection_scan/anti_gaming pattern.
    fn git(root: &Path, args: &[&str]) {
        crate::git::testutil::git_expect(root, args);
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).expect("mkdir");
        std::fs::write(path, content).expect("write");
    }

    fn git_fixture() -> TempDir {
        let tmp = TempDir::new().expect("temp dir");
        git(tmp.path(), &["init", "-q"]);
        tmp
    }

    fn track_all(root: &Path) {
        git(root, &["add", "-A"]);
    }

    // --- symbol extraction ---------------------------------------------------

    #[test]
    fn typescript_symbols_extracted_with_exported_first() {
        let tmp = git_fixture();
        write(
            tmp.path(),
            "a.ts",
            r#"
import { other } from './b';
function internalHelper() {}
export function publicFn() {}
export class Widget {}
export interface Shape { x: number }
export type Alias = string;
export enum Color { Red }
export const arrowFn = () => 1;
const plainData = 42;
const localFn = function () {};
"#,
        );
        write(tmp.path(), "b.ts", "export const other = () => 0;\n");
        track_all(tmp.path());

        let map = generate(tmp.path()).expect("map generated");
        let a_line = map
            .lines()
            .find(|l| l.contains("`a.ts`"))
            .expect("a.ts listed");
        for sym in ["publicFn", "Widget", "Shape", "Alias", "Color", "arrowFn"] {
            assert!(a_line.contains(sym), "missing {sym} in: {a_line}");
        }
        assert!(
            a_line.contains("internalHelper"),
            "non-exported fn included"
        );
        assert!(a_line.contains("localFn"), "const fn-expression included");
        assert!(
            !a_line.contains("plainData"),
            "plain data const must be excluded: {a_line}"
        );
        // Exported symbols precede non-exported ones.
        let pub_at = a_line.find("publicFn").unwrap();
        let helper_at = a_line.find("internalHelper").unwrap();
        assert!(pub_at < helper_at, "exported symbols sort first");
    }

    #[test]
    fn rust_symbols_extracted() {
        let tmp = git_fixture();
        write(
            tmp.path(),
            "src/main.rs",
            r#"
mod util;
pub struct Config { pub name: String }
pub enum Mode { Fast, Slow }
pub trait Runner { fn run(&self); }
type LocalAlias = u8;
impl Runner for Config { fn run(&self) {} }
fn private_helper() {}
pub fn entry() {}
fn main() {}
"#,
        );
        write(tmp.path(), "src/util.rs", "pub fn helper() {}\n");
        track_all(tmp.path());

        let map = generate(tmp.path()).expect("map generated");
        let line = map
            .lines()
            .find(|l| l.contains("`src/main.rs`"))
            .expect("main.rs listed");
        for sym in [
            "Config",
            "Mode",
            "Runner",
            "impl Runner for Config",
            "entry",
        ] {
            assert!(line.contains(sym), "missing {sym} in: {line}");
        }
    }

    // --- import resolution ---------------------------------------------------

    #[test]
    fn ts_imports_resolve_through_extensions_index_and_require() {
        let files: HashSet<String> = [
            "src/a.ts",
            "src/util.ts",
            "src/dir/index.ts",
            "src/esm.ts",
            "lib/legacy.js",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        // Bare extensionless specifier.
        assert_eq!(
            resolve_ts_import(&files, "src", "./util").as_deref(),
            Some("src/util.ts")
        );
        // Directory import → index file.
        assert_eq!(
            resolve_ts_import(&files, "src", "./dir").as_deref(),
            Some("src/dir/index.ts")
        );
        // ESM-style `.js` specifier written from a `.ts` source tree.
        assert_eq!(
            resolve_ts_import(&files, "src", "./esm.js").as_deref(),
            Some("src/esm.ts")
        );
        // Parent traversal.
        assert_eq!(
            resolve_ts_import(&files, "src", "../lib/legacy").as_deref(),
            Some("lib/legacy.js")
        );
        // Bare package specifiers are external — no edge.
        assert_eq!(resolve_ts_import(&files, "src", "react"), None);
        // Escaping the repo root is not an edge.
        assert_eq!(resolve_ts_import(&files, "", "../../etc/passwd"), None);
    }

    #[test]
    fn rust_use_and_mod_edges_resolve() {
        let files: HashSet<String> = [
            "src/main.rs",
            "src/store/mod.rs",
            "src/store/context.rs",
            "src/util.rs",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        // `use crate::store::context::…` from main.rs → the module file.
        let ctx = rust_module_ctx(&files, "src/main.rs");
        assert_eq!(ctx.crate_root.as_deref(), Some("src"));
        assert_eq!(
            resolve_rust_use(
                &files,
                &ctx,
                &[
                    "crate".into(),
                    "store".into(),
                    "context".into(),
                    "read_pack".into()
                ]
            )
            .as_deref(),
            Some("src/store/context.rs")
        );
        // Longest-prefix fallback: `crate::util::Item` → util.rs.
        assert_eq!(
            resolve_rust_use(
                &files,
                &ctx,
                &["crate".into(), "util".into(), "Item".into()]
            )
            .as_deref(),
            Some("src/util.rs")
        );
        // `use super::item` from a nested module file: the item lives in the
        // parent module's own file (`store/mod.rs`).
        let nested = rust_module_ctx(&files, "src/store/context.rs");
        assert_eq!(
            resolve_rust_use(&files, &nested, &["super".into(), "write_atomic".into()]).as_deref(),
            Some("src/store/mod.rs")
        );
        assert_eq!(
            resolve_rust_use(&files, &nested, &["crate".into(), "util".into()]).as_deref(),
            Some("src/util.rs")
        );
        // A crate-root item (`use crate::run`) edges to the crate root file.
        assert_eq!(
            resolve_rust_use(&files, &ctx, &["crate".into(), "run".into()]).as_deref(),
            Some("src/main.rs")
        );
        // External crates give no edge.
        assert_eq!(
            resolve_rust_use(&files, &ctx, &["serde".into(), "Serialize".into()]),
            None
        );
        // Brace expansion covers every member.
        let expanded = expand_use_paths("crate::{store::context, util}");
        assert_eq!(
            expanded,
            vec![
                vec![
                    "crate".to_string(),
                    "store".to_string(),
                    "context".to_string()
                ],
                vec!["crate".to_string(), "util".to_string()],
            ]
        );
    }

    // --- ranking ---------------------------------------------------------------

    #[test]
    fn hub_file_ranks_above_leaves() {
        let tmp = git_fixture();
        // hub.ts is imported by three leaves; leaves import nothing else.
        write(tmp.path(), "hub.ts", "export const shared = () => 1;\n");
        for leaf in ["a.ts", "b.ts", "c.ts"] {
            write(
                tmp.path(),
                leaf,
                "import { shared } from './hub';\nexport const use = () => shared();\n",
            );
        }
        track_all(tmp.path());

        let map = generate(tmp.path()).expect("map generated");
        let bullet_lines: Vec<&str> = map.lines().filter(|l| l.starts_with("- ")).collect();
        assert_eq!(bullet_lines.len(), 4);
        assert!(
            bullet_lines[0].contains("`hub.ts`"),
            "hub must rank first, got: {}",
            bullet_lines[0]
        );
    }

    // --- budget ----------------------------------------------------------------

    #[test]
    fn section_is_truncated_to_the_line_budget_with_elision_tail() {
        let tmp = git_fixture();
        // More files than the section can list.
        for i in 0..(REPO_MAP_SECTION_MAX_LINES + 20) {
            write(
                tmp.path(),
                &format!("f{i:04}.ts"),
                &format!("export const fn{i} = () => {i};\n"),
            );
        }
        track_all(tmp.path());

        let map = generate(tmp.path()).expect("map generated");
        let lines: Vec<&str> = map.lines().collect();
        assert!(
            lines.len() <= REPO_MAP_SECTION_MAX_LINES,
            "section exceeded budget: {} lines",
            lines.len()
        );
        let tail = lines.last().unwrap();
        assert!(
            tail.starts_with("… (") && tail.ends_with(" more files)"),
            "explicit elision tail expected, got: {tail}"
        );
    }

    // --- omission ----------------------------------------------------------------

    #[test]
    fn non_git_dir_yields_no_section() {
        let tmp = TempDir::new().expect("temp dir");
        std::fs::write(tmp.path().join("a.ts"), "export const f = () => 1;\n").unwrap();
        assert!(generate(tmp.path()).is_none(), "no git repo → no section");
    }

    #[test]
    fn repo_with_no_parseable_files_yields_no_section() {
        let tmp = git_fixture();
        write(tmp.path(), "README.md", "# hi\n");
        track_all(tmp.path());
        assert!(
            generate(tmp.path()).is_none(),
            "no source files → no section"
        );
    }

    // --- determinism ----------------------------------------------------------------

    #[test]
    fn two_runs_on_an_unchanged_tree_are_identical() {
        let tmp = git_fixture();
        write(tmp.path(), "hub.ts", "export const shared = () => 1;\n");
        write(
            tmp.path(),
            "a.ts",
            "import { shared } from './hub';\nexport const one = () => shared();\n",
        );
        write(
            tmp.path(),
            "src/main.rs",
            "mod util;\nuse crate::util::helper;\nfn main() { helper(); }\n",
        );
        write(tmp.path(), "src/util.rs", "pub fn helper() {}\n");
        track_all(tmp.path());

        let first = generate(tmp.path()).expect("first run");
        let second = generate(tmp.path()).expect("second run");
        assert_eq!(first, second, "map must be stable across runs");
    }

    #[test]
    #[ignore = "manual eyeball run against the real workspace"]
    fn eyeball_real_workspace() {
        let root = crate::store::workspace_root();
        let started = std::time::Instant::now();
        let map = generate(&root).expect("map");
        eprintln!("generated in {:?}\n{}", started.elapsed(), map);
    }

    #[test]
    fn oversized_files_are_skipped() {
        let tmp = git_fixture();
        write(tmp.path(), "small.ts", "export const ok = () => 1;\n");
        let big = format!(
            "export const big = () => 1;\n// {}\n",
            "x".repeat(MAX_FILE_BYTES as usize)
        );
        write(tmp.path(), "big.ts", &big);
        track_all(tmp.path());

        let map = generate(tmp.path()).expect("map generated");
        assert!(map.contains("`small.ts`"));
        assert!(!map.contains("`big.ts`"), "oversized file must be skipped");
    }
}
