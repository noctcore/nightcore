//! Import resolution: turn the raw specifiers ([`super::parse`] emits) into
//! repo-relative edges against the tracked-file set — the Node/TS candidate
//! ladder for TS/JS and the crate/self/super module walk for Rust — deduped and
//! sorted so the edge order feeds PageRank deterministically.

use std::collections::HashSet;
use std::path::Path;

use super::lang::Lang;
use super::parse::RustImports;

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
pub(super) fn resolve_ts_import(
    files: &HashSet<String>,
    from_dir: &str,
    spec: &str,
) -> Option<String> {
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
pub(super) fn expand_use_paths(arg: &str) -> Vec<Vec<String>> {
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
pub(super) struct RustModuleCtx {
    /// Where this file's CHILD modules live (`self::x`, `mod x;`):
    /// `store/mod.rs` → `store/`, `store/context.rs` → `store/context/`.
    children_dir: String,
    /// Where this file's SIBLING modules live (`super::x`):
    /// `store/context.rs` → `store/`, `store/mod.rs` → its parent dir.
    parent_dir: Option<String>,
    /// The crate's `src` root (`crate::x`): the nearest ancestor dir holding a
    /// tracked `lib.rs` or `main.rs`. `None` outside any crate.
    pub(super) crate_root: Option<String>,
}

pub(super) fn rust_module_ctx(files: &HashSet<String>, file: &str) -> RustModuleCtx {
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
pub(super) fn resolve_rust_use(
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
pub(super) fn resolve_imports(
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
