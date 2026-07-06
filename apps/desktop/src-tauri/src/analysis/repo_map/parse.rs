//! tree-sitter extraction: one reusable [`Parsers`] set per grammar, plus the
//! per-language walks that pull each file's top-level definition [`Symbol`]s and
//! its raw import specifiers (TS/JS strings; Rust [`RustImports`] `use`/`mod`).

use tree_sitter::{Language, Node, Parser};

use super::lang::{Lang, Symbol};

/// One reusable parser per grammar; `parse_file` picks by extension.
pub(super) struct Parsers {
    ts: Parser,
    tsx: Parser,
    js: Parser,
    rust: Parser,
}

impl Parsers {
    pub(super) fn new() -> Option<Self> {
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

    pub(super) fn for_lang(&mut self, lang: Lang) -> &mut Parser {
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
pub(super) fn extract_ts_js(root: Node<'_>, src: &str) -> (Vec<Symbol>, Vec<String>) {
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
pub(super) struct RustImports {
    pub(super) use_paths: Vec<String>,
    pub(super) mods: Vec<String>,
}

/// Rust extraction: top-level items (fns, structs, enums, traits, types,
/// unions, macros, impl blocks) plus `use`/`mod` edges.
pub(super) fn extract_rust(root: Node<'_>, src: &str) -> (Vec<Symbol>, RustImports) {
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
