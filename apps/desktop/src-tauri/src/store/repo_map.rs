//! Ranked repo map for the Pre-flight Context Pack (hardening module #14, prior
//! art: Aider's repomap). A deterministic, zero-token generator: tree-sitter
//! parses the project's git-tracked TS/TSX/JS/Rust sources, extracts each file's
//! top-level definition symbols plus its import edges, ranks files with PageRank
//! over the import graph, and renders a budgeted Markdown section that
//! [`crate::store::context::assemble_default`] appends to the pack.
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

use std::collections::{HashMap, HashSet};
use std::path::Path;

use tree_sitter::{Language, Node, Parser};

/// Hard ceiling on the rendered section, in lines (heading + prose + bullets +
/// elision tail included). Keeps the map from crowding out the curated pack —
/// the engine additionally truncates the whole pack to a token budget.
pub const REPO_MAP_SECTION_MAX_LINES: usize = 120;

/// Cap on how many tracked source files are parsed. Path-sorted before the cut,
/// so on a monster repo the map covers a stable, deterministic prefix instead of
/// an arbitrary one. 4000 files × sub-ms tree-sitter parses keeps regeneration
/// interactive on user click.
const MAX_PARSED_FILES: usize = 4000;

/// Files larger than this are skipped — minified bundles and generated blobs,
/// not the hand-written source the map is for.
const MAX_FILE_BYTES: u64 = 512 * 1024;

/// How many definition symbols a file's line lists before eliding with `…`.
const MAX_SYMBOLS_PER_FILE: usize = 8;

/// PageRank damping factor (the standard 0.85) and iteration count. Thirty
/// power iterations converge far past display precision for repo-sized graphs.
const PAGERANK_DAMPING: f64 = 0.85;
const PAGERANK_ITERATIONS: usize = 30;

/// The languages the map parses; everything else in `git ls-files` is ignored.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Lang {
    TypeScript,
    Tsx,
    JavaScript,
    Rust,
}

fn lang_for(path: &str) -> Option<Lang> {
    let ext = Path::new(path).extension()?.to_str()?;
    match ext {
        "ts" => Some(Lang::TypeScript),
        "tsx" => Some(Lang::Tsx),
        "js" | "jsx" | "mjs" | "cjs" => Some(Lang::JavaScript),
        "rs" => Some(Lang::Rust),
        _ => None,
    }
}

/// One top-level definition. `exported` (TS `export` / Rust `pub`) items sort
/// first within a file's line — they are the file's public surface.
#[derive(Debug, Clone)]
struct Symbol {
    name: String,
    exported: bool,
}

/// Everything extracted from one parsed file.
struct FileFacts {
    /// Repo-relative path (git's forward-slash form).
    path: String,
    symbols: Vec<Symbol>,
    /// Repo-relative paths of files this one imports (resolved, deduped).
    imports: Vec<String>,
}

// --- git file listing --------------------------------------------------------

/// Git-tracked files with a parseable extension, path-sorted, size-filtered and
/// capped at [`MAX_PARSED_FILES`]. `None` when `root` is not a git repo (or git
/// itself fails) — the caller omits the section.
fn tracked_source_files(root: &Path) -> Option<Vec<String>> {
    let output = crate::platform::std_command("git")
        .args(["ls-files", "-z"])
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let listing = String::from_utf8_lossy(&output.stdout);
    let mut files: Vec<String> = listing
        .split('\0')
        .filter(|p| !p.is_empty() && lang_for(p).is_some())
        .map(str::to_string)
        .collect();
    // Path-sort BEFORE the cap so the parsed subset is stable across runs.
    files.sort();
    files.truncate(MAX_PARSED_FILES);
    files.retain(|rel| {
        std::fs::metadata(root.join(rel))
            .map(|m| m.is_file() && m.len() <= MAX_FILE_BYTES)
            .unwrap_or(false)
    });
    Some(files)
}

// --- tree-sitter extraction --------------------------------------------------

/// One reusable parser per grammar; `parse_file` picks by extension.
struct Parsers {
    ts: Parser,
    tsx: Parser,
    js: Parser,
    rust: Parser,
}

impl Parsers {
    fn new() -> Option<Self> {
        fn parser(language: Language) -> Option<Parser> {
            let mut p = Parser::new();
            p.set_language(&language).ok()?;
            Some(p)
        }
        Some(Self {
            ts: parser(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())?,
            tsx: parser(tree_sitter_typescript::LANGUAGE_TSX.into())?,
            js: parser(tree_sitter_javascript::LANGUAGE.into())?,
            rust: parser(tree_sitter_rust::LANGUAGE.into())?,
        })
    }

    fn for_lang(&mut self, lang: Lang) -> &mut Parser {
        match lang {
            Lang::TypeScript => &mut self.ts,
            Lang::Tsx => &mut self.tsx,
            Lang::JavaScript => &mut self.js,
            Lang::Rust => &mut self.rust,
        }
    }
}

fn node_text<'a>(node: Node<'_>, src: &'a str) -> &'a str {
    node.utf8_text(src.as_bytes()).unwrap_or("")
}

fn named_children<'t>(node: Node<'t>) -> impl Iterator<Item = Node<'t>> {
    (0..node.named_child_count() as u32).filter_map(move |i| node.named_child(i))
}

/// Strip the quotes off a `string` node's text (`'./x'` / `"./x"` → `./x`).
fn unquote(raw: &str) -> &str {
    raw.trim_matches(|c| c == '"' || c == '\'' || c == '`')
}

/// Push `name` unless it is empty or already collected (impl blocks and
/// overload signatures repeat names; the first occurrence wins).
fn push_symbol(symbols: &mut Vec<Symbol>, name: &str, exported: bool) {
    if name.is_empty() || symbols.iter().any(|s| s.name == name) {
        return;
    }
    symbols.push(Symbol {
        name: name.to_string(),
        exported,
    });
}

/// TS/TSX/JS extraction: top-level definitions (unwrapping `export` statements)
/// plus every import specifier — static `import`/`export … from`, `require()`,
/// and dynamic `import()` anywhere in the tree.
fn extract_ts_js(root: Node<'_>, src: &str) -> (Vec<Symbol>, Vec<String>) {
    let mut symbols = Vec::new();
    let mut specs = Vec::new();

    fn declaration_symbols(node: Node<'_>, src: &str, exported: bool, out: &mut Vec<Symbol>) {
        match node.kind() {
            "function_declaration"
            | "generator_function_declaration"
            | "class_declaration"
            | "abstract_class_declaration"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration"
            | "function_signature" => {
                if let Some(name) = node.child_by_field_name("name") {
                    push_symbol(out, node_text(name, src), exported);
                }
            }
            // `const x = () => …` / `const x = function …` — consts with
            // function values are definitions; plain data consts are not.
            "lexical_declaration" | "variable_declaration" => {
                for decl in named_children(node).filter(|c| c.kind() == "variable_declarator") {
                    let is_fn = decl
                        .child_by_field_name("value")
                        .map(|v| {
                            matches!(
                                v.kind(),
                                "arrow_function"
                                    | "function_expression"
                                    | "function"
                                    | "generator_function"
                            )
                        })
                        .unwrap_or(false);
                    if !is_fn {
                        continue;
                    }
                    if let Some(name) = decl.child_by_field_name("name") {
                        if name.kind() == "identifier" {
                            push_symbol(out, node_text(name, src), exported);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    for child in named_children(root) {
        match child.kind() {
            "import_statement" => {
                if let Some(source) = child.child_by_field_name("source") {
                    specs.push(unquote(node_text(source, src)).to_string());
                }
            }
            "export_statement" => {
                // Re-exports (`export … from './x'`) are edges too.
                if let Some(source) = child.child_by_field_name("source") {
                    specs.push(unquote(node_text(source, src)).to_string());
                }
                if let Some(decl) = child.child_by_field_name("declaration") {
                    declaration_symbols(decl, src, true, &mut symbols);
                }
            }
            _ => declaration_symbols(child, src, false, &mut symbols),
        }
    }

    // `require('./x')` and dynamic `import('./x')` can sit anywhere; one full
    // walk collects them (cheap — the tree is already built).
    fn walk_calls(node: Node<'_>, src: &str, specs: &mut Vec<String>) {
        if node.kind() == "call_expression" {
            let callee_is_import = node
                .child_by_field_name("function")
                .map(|f| {
                    f.kind() == "import"
                        || (f.kind() == "identifier" && node_text(f, src) == "require")
                })
                .unwrap_or(false);
            if callee_is_import {
                if let Some(args) = node.child_by_field_name("arguments") {
                    if let Some(first) = named_children(args).next() {
                        if first.kind() == "string" {
                            specs.push(unquote(node_text(first, src)).to_string());
                        }
                    }
                }
            }
        }
        for child in (0..node.child_count() as u32).filter_map(|i| node.child(i)) {
            walk_calls(child, src, specs);
        }
    }
    walk_calls(root, src, &mut specs);

    (symbols, specs)
}

/// A Rust file's imports before resolution: `use` paths (raw text) and bodyless
/// `mod` declarations (child-module names).
struct RustImports {
    use_paths: Vec<String>,
    mods: Vec<String>,
}

/// Rust extraction: top-level items (fns, structs, enums, traits, types,
/// unions, macros, impl blocks) plus `use`/`mod` edges.
fn extract_rust(root: Node<'_>, src: &str) -> (Vec<Symbol>, RustImports) {
    let mut symbols = Vec::new();
    let mut imports = RustImports {
        use_paths: Vec::new(),
        mods: Vec::new(),
    };

    for child in named_children(root) {
        let is_pub = named_children(child).any(|c| c.kind() == "visibility_modifier");
        match child.kind() {
            "function_item" | "struct_item" | "enum_item" | "union_item" | "trait_item"
            | "type_item" | "macro_definition" => {
                if let Some(name) = child.child_by_field_name("name") {
                    push_symbol(&mut symbols, node_text(name, src), is_pub);
                }
            }
            "impl_item" => {
                if let Some(ty) = child.child_by_field_name("type") {
                    let name = match child.child_by_field_name("trait") {
                        Some(tr) => {
                            format!("impl {} for {}", node_text(tr, src), node_text(ty, src))
                        }
                        None => format!("impl {}", node_text(ty, src)),
                    };
                    // An impl is surface regardless of item visibility.
                    push_symbol(&mut symbols, &name, true);
                }
            }
            "use_declaration" => {
                if let Some(arg) = child.child_by_field_name("argument") {
                    imports.use_paths.push(node_text(arg, src).to_string());
                }
            }
            "mod_item" => {
                // `mod foo;` (no body) points at a child-module FILE — an edge.
                // An inline `mod tests { … }` is neither an edge nor a symbol.
                let has_body = named_children(child).any(|c| c.kind() == "declaration_list");
                if !has_body {
                    if let Some(name) = child.child_by_field_name("name") {
                        imports.mods.push(node_text(name, src).to_string());
                    }
                }
            }
            _ => {}
        }
    }
    (symbols, imports)
}

// --- import resolution -------------------------------------------------------

/// Join `spec` onto `base_dir` (both repo-relative, `/`-separated), resolving
/// `.`/`..` logically. `None` if the path escapes the repo root.
fn normalize_rel(base_dir: &str, spec: &str) -> Option<String> {
    let mut parts: Vec<&str> = if base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').collect()
    };
    for seg in spec.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

/// Resolve a TS/JS import specifier from `from_dir` against the tracked-file
/// set. Only relative specifiers resolve (bare package names are external —
/// including workspace packages, which cross a package boundary the map treats
/// as opaque). Tries the Node/TS candidate ladder: exact, `+ext`, the ESM
/// `.js`-written-for-`.ts` alias, and directory `index.*`.
fn resolve_ts_import(files: &HashSet<String>, from_dir: &str, spec: &str) -> Option<String> {
    if !(spec.starts_with("./") || spec.starts_with("../")) {
        return None;
    }
    let base = normalize_rel(from_dir, spec)?;
    let mut candidates = vec![base.clone()];
    for ext in ["ts", "tsx", "js", "jsx", "mjs", "cjs"] {
        candidates.push(format!("{base}.{ext}"));
    }
    for (written, actual) in [
        (".js", ".ts"),
        (".js", ".tsx"),
        (".mjs", ".ts"),
        (".cjs", ".ts"),
    ] {
        if let Some(stem) = base.strip_suffix(written) {
            candidates.push(format!("{stem}{actual}"));
        }
    }
    for index in ["index.ts", "index.tsx", "index.js", "index.jsx"] {
        candidates.push(format!("{base}/{index}"));
    }
    candidates.into_iter().find(|c| files.contains(c))
}

/// Expand a `use` declaration's argument into flat segment paths:
/// `crate::{a, b::c}` → `[["crate","a"], ["crate","b","c"]]`. Handles nested
/// braces, `as` renames (dropped), and `*` globs (dropped as a segment).
fn expand_use_paths(arg: &str) -> Vec<Vec<String>> {
    fn split_top_level_commas(s: &str) -> Vec<&str> {
        let mut parts = Vec::new();
        let mut depth = 0usize;
        let mut start = 0usize;
        for (i, c) in s.char_indices() {
            match c {
                '{' => depth += 1,
                '}' => depth = depth.saturating_sub(1),
                ',' if depth == 0 => {
                    parts.push(&s[start..i]);
                    start = i + 1;
                }
                _ => {}
            }
        }
        parts.push(&s[start..]);
        parts
    }

    fn expand(prefix: &[String], s: &str, out: &mut Vec<Vec<String>>) {
        let s = s.trim();
        if s.is_empty() {
            if !prefix.is_empty() {
                out.push(prefix.to_vec());
            }
            return;
        }
        // A brace group fans out over its comma-separated members.
        if let Some(inner) = s.strip_prefix('{').and_then(|r| r.strip_suffix('}')) {
            for part in split_top_level_commas(inner) {
                expand(prefix, part, out);
            }
            return;
        }
        // Take the head segment up to a top-level `::`, recurse on the rest.
        let mut depth = 0usize;
        let bytes = s.as_bytes();
        let mut split_at = None;
        for i in 0..bytes.len().saturating_sub(1) {
            match bytes[i] {
                b'{' => depth += 1,
                b'}' => depth = depth.saturating_sub(1),
                b':' if depth == 0 && bytes[i + 1] == b':' => {
                    split_at = Some(i);
                    break;
                }
                _ => {}
            }
        }
        match split_at {
            Some(i) => {
                let head = s[..i].trim();
                let rest = &s[i + 2..];
                let mut next = prefix.to_vec();
                if !head.is_empty() {
                    next.push(head.to_string());
                }
                expand(&next, rest, out);
            }
            None => {
                // Terminal segment: drop `as` renames and glob stars.
                let terminal = s.split_whitespace().next().unwrap_or("");
                let mut path = prefix.to_vec();
                if !terminal.is_empty() && terminal != "*" {
                    path.push(terminal.to_string());
                }
                if !path.is_empty() {
                    out.push(path);
                }
            }
        }
    }

    let mut out = Vec::new();
    expand(&[], arg, &mut out);
    out
}

/// Per-file Rust module coordinates, derived from its repo-relative path.
struct RustModuleCtx {
    /// Where this file's CHILD modules live (`self::x`, `mod x;`):
    /// `store/mod.rs` → `store/`, `store/context.rs` → `store/context/`.
    children_dir: String,
    /// Where this file's SIBLING modules live (`super::x`):
    /// `store/context.rs` → `store/`, `store/mod.rs` → its parent dir.
    parent_dir: Option<String>,
    /// The crate's `src` root (`crate::x`): the nearest ancestor dir holding a
    /// tracked `lib.rs` or `main.rs`. `None` outside any crate.
    crate_root: Option<String>,
}

fn rust_module_ctx(files: &HashSet<String>, file: &str) -> RustModuleCtx {
    let dir = match file.rfind('/') {
        Some(i) => &file[..i],
        None => "",
    };
    let stem = Path::new(file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let is_root_file = matches!(stem, "mod" | "lib" | "main");

    let children_dir = if is_root_file {
        dir.to_string()
    } else if dir.is_empty() {
        stem.to_string()
    } else {
        format!("{dir}/{stem}")
    };
    let parent_dir = if is_root_file {
        // `mod.rs`'s super lives one directory up; `lib.rs`/`main.rs` have none.
        (stem == "mod").then(|| {
            dir.rfind('/')
                .map(|i| dir[..i].to_string())
                .unwrap_or_default()
        })
    } else {
        Some(dir.to_string())
    };

    // Nearest ancestor dir (this file's own dir first) containing lib.rs/main.rs.
    let mut crate_root = None;
    let mut probe = dir.to_string();
    loop {
        let (lib, main) = if probe.is_empty() {
            ("lib.rs".to_string(), "main.rs".to_string())
        } else {
            (format!("{probe}/lib.rs"), format!("{probe}/main.rs"))
        };
        if files.contains(&lib) || files.contains(&main) {
            crate_root = Some(probe);
            break;
        }
        match probe.rfind('/') {
            Some(i) => probe.truncate(i),
            None if !probe.is_empty() => probe.clear(),
            None => break,
        }
    }

    RustModuleCtx {
        children_dir,
        parent_dir,
        crate_root,
    }
}

/// Resolve a module segment path from `base` to a tracked file, trying the
/// longest prefix first (`a::b::Item` → `a/b.rs` before `a.rs`), each as
/// `<path>.rs` then `<path>/mod.rs`.
fn resolve_mod_path(files: &HashSet<String>, base: &str, segs: &[String]) -> Option<String> {
    for take in (1..=segs.len()).rev() {
        let joined = segs[..take].join("/");
        let stem = if base.is_empty() {
            joined
        } else {
            format!("{base}/{}", joined)
        };
        let file = format!("{stem}.rs");
        if files.contains(&file) {
            return Some(file);
        }
        let mod_file = format!("{stem}/mod.rs");
        if files.contains(&mod_file) {
            return Some(mod_file);
        }
    }
    None
}

/// The file that IS the module rooted at `base`: its `mod.rs`, or the crate
/// root's `lib.rs`/`main.rs`. Used when a `use` path names an item defined in
/// the anchor module itself (`use super::write_atomic`) rather than a
/// descendant module file.
fn module_own_file(files: &HashSet<String>, base: &str) -> Option<String> {
    for name in ["mod.rs", "lib.rs", "main.rs"] {
        let candidate = if base.is_empty() {
            name.to_string()
        } else {
            format!("{base}/{name}")
        };
        if files.contains(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Resolve one expanded `use` path from `file` to a tracked repo file, if it
/// targets this crate (`crate::`/`super::`/`self::`). External crates — std,
/// deps, and sibling workspace crates referenced by name — yield no edge. A
/// path whose segments name no module file falls back to the anchor module's
/// own file (the item is defined there).
fn resolve_rust_use(
    files: &HashSet<String>,
    ctx: &RustModuleCtx,
    path: &[String],
) -> Option<String> {
    let (anchor, rest) = path.split_first()?;
    let (base, rest) = match anchor.as_str() {
        "crate" => (ctx.crate_root.clone()?, rest),
        "self" => (ctx.children_dir.clone(), rest),
        "super" => {
            // Consume the leading `super`s, walking one module level each.
            let mut base = ctx.parent_dir.clone()?;
            let mut rest = rest;
            while rest.first().map(String::as_str) == Some("super") {
                base = match base.rfind('/') {
                    Some(i) => base[..i].to_string(),
                    None if !base.is_empty() => String::new(),
                    None => return None,
                };
                rest = &rest[1..];
            }
            (base, rest)
        }
        _ => return None,
    };
    resolve_mod_path(files, &base, rest).or_else(|| module_own_file(files, &base))
}

/// All import edges for one file, resolved to repo-relative paths, deduped and
/// sorted (edge order feeds PageRank, so it must be stable).
fn resolve_imports(
    files: &HashSet<String>,
    path: &str,
    lang: Lang,
    ts_specs: &[String],
    rust_imports: Option<&RustImports>,
) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    match lang {
        Lang::TypeScript | Lang::Tsx | Lang::JavaScript => {
            let from_dir = path.rfind('/').map(|i| &path[..i]).unwrap_or("");
            for spec in ts_specs {
                if let Some(t) = resolve_ts_import(files, from_dir, spec) {
                    targets.push(t);
                }
            }
        }
        Lang::Rust => {
            if let Some(imports) = rust_imports {
                let ctx = rust_module_ctx(files, path);
                for use_path in &imports.use_paths {
                    for expanded in expand_use_paths(use_path) {
                        if let Some(t) = resolve_rust_use(files, &ctx, &expanded) {
                            targets.push(t);
                        }
                    }
                }
                for m in &imports.mods {
                    if let Some(t) =
                        resolve_mod_path(files, &ctx.children_dir, std::slice::from_ref(m))
                    {
                        targets.push(t);
                    }
                }
            }
        }
    }
    targets.retain(|t| t != path); // self-imports are not edges
    targets.sort();
    targets.dedup();
    targets
}

// --- PageRank ----------------------------------------------------------------

/// Power-iteration PageRank over the file digraph (edge: importer → imported).
/// Dangling mass is redistributed uniformly. Deterministic: fixed iteration
/// count, fixed index order, no thresholds.
fn pagerank(node_count: usize, out_edges: &[Vec<usize>]) -> Vec<f64> {
    let n = node_count as f64;
    let mut rank = vec![1.0 / n; node_count];
    for _ in 0..PAGERANK_ITERATIONS {
        let mut next = vec![(1.0 - PAGERANK_DAMPING) / n; node_count];
        let mut dangling = 0.0;
        for (i, outs) in out_edges.iter().enumerate() {
            if outs.is_empty() {
                dangling += rank[i];
                continue;
            }
            let share = PAGERANK_DAMPING * rank[i] / outs.len() as f64;
            for &j in outs {
                next[j] += share;
            }
        }
        let dangling_share = PAGERANK_DAMPING * dangling / n;
        for v in next.iter_mut() {
            *v += dangling_share;
        }
        rank = next;
    }
    rank
}

// --- assembly ----------------------------------------------------------------

/// Parse every tracked source file and extract its facts. Unreadable files are
/// skipped; a file that parses with errors still yields whatever it can.
fn collect_facts(root: &Path, files: &[String]) -> Vec<FileFacts> {
    let Some(mut parsers) = Parsers::new() else {
        return Vec::new();
    };
    let file_set: HashSet<String> = files.iter().cloned().collect();
    let mut facts = Vec::with_capacity(files.len());
    for rel in files {
        let Some(lang) = lang_for(rel) else { continue };
        let Ok(source) = std::fs::read_to_string(root.join(rel)) else {
            continue;
        };
        let Some(tree) = parsers.for_lang(lang).parse(&source, None) else {
            continue;
        };
        let root_node = tree.root_node();
        let (symbols, imports) = match lang {
            Lang::Rust => {
                let (symbols, rust_imports) = extract_rust(root_node, &source);
                let imports = resolve_imports(&file_set, rel, lang, &[], Some(&rust_imports));
                (symbols, imports)
            }
            _ => {
                let (symbols, specs) = extract_ts_js(root_node, &source);
                let imports = resolve_imports(&file_set, rel, lang, &specs, None);
                (symbols, imports)
            }
        };
        facts.push(FileFacts {
            path: rel.clone(),
            symbols,
            imports,
        });
    }
    facts
}

/// Render the ranked map as a Markdown section, truncated to the line budget.
fn render(mut facts: Vec<FileFacts>) -> String {
    // Graph indices follow the path-sorted facts order (stable input → stable
    // ranks). `facts` is already path-sorted because the file list was.
    let index_of: HashMap<&str, usize> = facts
        .iter()
        .enumerate()
        .map(|(i, f)| (f.path.as_str(), i))
        .collect();
    let out_edges: Vec<Vec<usize>> = facts
        .iter()
        .map(|f| {
            f.imports
                .iter()
                .filter_map(|t| index_of.get(t.as_str()).copied())
                .collect()
        })
        .collect();
    let ranks = pagerank(facts.len(), &out_edges);

    // Rank descending; ties (equal float ranks) break by path ascending.
    let mut order: Vec<usize> = (0..facts.len()).collect();
    order.sort_by(|&a, &b| {
        ranks[b]
            .partial_cmp(&ranks[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| facts[a].path.cmp(&facts[b].path))
    });

    let mut lines: Vec<String> = vec![
        "## Repo Map (auto-generated)".to_string(),
        String::new(),
        "Key files ranked by import-graph centrality (PageRank); each line lists the \
file's top definitions. Regenerated deterministically with this pack."
            .to_string(),
        String::new(),
    ];

    // Reserve one line for the elision tail whenever it will be needed.
    let body_budget = REPO_MAP_SECTION_MAX_LINES - lines.len();
    let shown = if facts.len() > body_budget {
        body_budget - 1
    } else {
        facts.len()
    };
    for &i in order.iter().take(shown) {
        let f = &mut facts[i];
        // Exported/pub definitions first (stable sort keeps source order within
        // each group), then cap the list.
        f.symbols.sort_by_key(|s| !s.exported);
        let names: Vec<&str> = f
            .symbols
            .iter()
            .take(MAX_SYMBOLS_PER_FILE)
            .map(|s| s.name.as_str())
            .collect();
        let line = if names.is_empty() {
            format!("- `{}`", f.path)
        } else {
            let ellipsis = if f.symbols.len() > MAX_SYMBOLS_PER_FILE {
                ", …"
            } else {
                ""
            };
            format!("- `{}` — {}{}", f.path, names.join(", "), ellipsis)
        };
        lines.push(line);
    }
    if shown < facts.len() {
        lines.push(format!("… ({} more files)", facts.len() - shown));
    }
    lines.join("\n")
}

/// Generate the repo-map section for `project_root`, or `None` when the project
/// is not a git repo (or git fails) or has no parseable source files — the
/// Context Pack then omits the section entirely.
pub fn generate(project_root: &Path) -> Option<String> {
    let files = tracked_source_files(project_root)?;
    if files.is_empty() {
        return None;
    }
    let facts = collect_facts(project_root, &files);
    if facts.is_empty() {
        return None;
    }
    Some(render(facts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A git repo fixture: `write` files, then `commit` (add -A + commit) so
    /// `git ls-files` sees them. Mirrors the injection_scan/anti_gaming pattern.
    fn git(root: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
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
