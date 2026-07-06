//! Assembly + rendering: parse every tracked file into [`FileFacts`], rank them
//! with PageRank over the import digraph, and render the budgeted Markdown
//! section. [`generate`] is the public entry point.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use super::lang::{lang_for, tracked_source_files, FileFacts, Lang, MAX_SYMBOLS_PER_FILE};
use super::parse::{extract_rust, extract_ts_js, Parsers};
use super::resolve::resolve_imports;

/// Hard ceiling on the rendered section, in lines (heading + prose + bullets +
/// elision tail included). Keeps the map from crowding out the curated pack —
/// the engine additionally truncates the whole pack to a token budget.
pub const REPO_MAP_SECTION_MAX_LINES: usize = 120;

/// PageRank damping factor (the standard 0.85) and iteration count. Thirty
/// power iterations converge far past display precision for repo-sized graphs.
const PAGERANK_DAMPING: f64 = 0.85;
const PAGERANK_ITERATIONS: usize = 30;

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
