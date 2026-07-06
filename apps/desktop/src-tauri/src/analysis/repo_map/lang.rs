//! Language classification + the parse budget, plus the extracted-facts shapes
//! ([`Symbol`], [`FileFacts`]) the rest of the pipeline fills in, and the
//! git-tracked source-file listing that feeds it.

use std::path::Path;

/// Cap on how many tracked source files are parsed. Path-sorted before the cut,
/// so on a monster repo the map covers a stable, deterministic prefix instead of
/// an arbitrary one. 4000 files × sub-ms tree-sitter parses keeps regeneration
/// interactive on user click.
const MAX_PARSED_FILES: usize = 4000;

/// Files larger than this are skipped — minified bundles and generated blobs,
/// not the hand-written source the map is for.
pub(super) const MAX_FILE_BYTES: u64 = 512 * 1024;

/// How many definition symbols a file's line lists before eliding with `…`.
pub(super) const MAX_SYMBOLS_PER_FILE: usize = 8;

/// The languages the map parses; everything else in `git ls-files` is ignored.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Lang {
    TypeScript,
    Tsx,
    JavaScript,
    Rust,
}

pub(super) fn lang_for(path: &str) -> Option<Lang> {
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
pub(super) struct Symbol {
    pub(super) name: String,
    pub(super) exported: bool,
}

/// Everything extracted from one parsed file.
pub(super) struct FileFacts {
    /// Repo-relative path (git's forward-slash form).
    pub(super) path: String,
    pub(super) symbols: Vec<Symbol>,
    /// Repo-relative paths of files this one imports (resolved, deduped).
    pub(super) imports: Vec<String>,
}

/// Git-tracked files with a parseable extension, path-sorted, size-filtered and
/// capped at [`MAX_PARSED_FILES`]. `None` when `root` is not a git repo (or git
/// itself fails) — the caller omits the section.
pub(super) fn tracked_source_files(root: &Path) -> Option<Vec<String>> {
    let mut files: Vec<String> = crate::git::query::list_tracked_files(root, &[])
        .ok()?
        .into_iter()
        .filter(|p| lang_for(p).is_some())
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
