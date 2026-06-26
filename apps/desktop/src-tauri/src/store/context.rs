//! Pre-flight Context Pack (Lock, feature #4) — the curated, Nightcore-controlled
//! project **Constitution** injected into every agent run's `appendSystemPrompt`.
//!
//! Unlike the task/insight/scorecard stores there is NO in-memory registry: the pack
//! is a single per-project Markdown file at `<project>/.nightcore/context.md`, read
//! on dispatch (by the coordinator) and edited from the Constitution surface. This
//! module is the pure get/set + default-assembly seam.
//!
//! ## Trust model
//! The injected pack is whatever lives at `.nightcore/context.md` — a Nightcore-owned,
//! user-curated file. [`assemble_default`] is a CONVENIENCE that seeds that file from
//! existing on-disk sources (the project `CLAUDE.md`/`AGENTS.md` if present, plus
//! `.nightcore/memory/*.md`); the user reviews/edits the result before it becomes
//! load-bearing, and the curated `context.md` is what the agent actually receives.
//! The engine additionally truncates the pack to a token budget so it can't crowd out
//! the task, and the coordinator gates injection on a per-project settings toggle.

use std::path::{Path, PathBuf};

use tauri::State;

use crate::project::ProjectStore;

/// The Nightcore-owned Constitution file for a project: `<path>/.nightcore/context.md`.
fn context_file(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".nightcore/context.md")
}

/// The Nightcore memory dir for a project: `<path>/.nightcore/memory`.
fn memory_dir(project_path: &str) -> PathBuf {
    Path::new(project_path).join(".nightcore/memory")
}

/// Read the curated context pack for a project, if a non-empty `context.md` exists.
/// Returns `None` when the file is missing, unreadable, or blank — so the coordinator
/// treats "no pack" identically whether the file is absent or empty (the pre-feature
/// shape: nothing injected).
pub fn read_pack(project_path: &str) -> Option<String> {
    let raw = std::fs::read_to_string(context_file(project_path)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(raw)
    }
}

/// Write the curated context pack for a project, creating `.nightcore/` if needed.
/// Atomic temp-file + rename (data-integrity), matching the other stores.
pub fn write_pack(project_path: &str, content: &str) -> Result<(), String> {
    let path = context_file(project_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    crate::store::write_atomic(&path, content.as_bytes())
        .map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Read a single source file, returning its trimmed contents only when non-empty.
fn read_source(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The `.nightcore/memory/*.md` files for a project, sorted by file name for a
/// stable, deterministic pack. Non-`.md` files and unreadable entries are skipped.
fn memory_files(project_path: &str) -> Vec<(String, String)> {
    let dir = memory_dir(project_path);
    let mut entries: Vec<(String, String)> = Vec::new();
    let Ok(read) = std::fs::read_dir(&dir) else {
        return entries;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if let Some(body) = read_source(&path) {
            entries.push((name, body));
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}

/// Assemble a DEFAULT context pack for a project from existing on-disk sources: the
/// project Constitution (`CLAUDE.md`/`AGENTS.md` at the repo root, if present) and
/// every `.nightcore/memory/*.md` (sorted). Sections that have no source are omitted.
/// The result is a Markdown document the user seeds `context.md` with (via the
/// "regenerate from sources" action) and then curates — it is not auto-injected until
/// it is saved as `context.md`.
pub fn assemble_default(project_path: &str) -> String {
    let mut sections: Vec<String> = Vec::new();

    // Project Constitution — the Harness-managed CLAUDE.md / AGENTS.md if present.
    for (label, file) in [("CLAUDE.md", "CLAUDE.md"), ("AGENTS.md", "AGENTS.md")] {
        if let Some(body) = read_source(&Path::new(project_path).join(file)) {
            sections.push(format!("## Project Constitution ({label})\n\n{body}"));
        }
    }

    // Nightcore memory notes (clearly Nightcore-owned, always trusted).
    let memory = memory_files(project_path);
    if !memory.is_empty() {
        let mut block = String::from("## Project Memory (.nightcore/memory)");
        for (name, body) in memory {
            block.push_str(&format!("\n\n### {name}\n\n{body}"));
        }
        sections.push(block);
    }

    let preamble = "# Pre-flight Context Pack\n\nNightcore injects this trusted, \
project-controlled context into every agent run so the agent starts knowing the \
project's rules instead of rediscovering (or violating) them. Edit it freely — it \
is Nightcore-owned, not the repository's untrusted input.";

    if sections.is_empty() {
        format!(
            "{preamble}\n\n_No on-disk sources found yet. Run Harness to generate a \
CLAUDE.md/AGENTS.md, or add notes under .nightcore/memory/, then regenerate._\n"
        )
    } else {
        format!("{preamble}\n\n{}\n", sections.join("\n\n"))
    }
}

// --- Commands ---------------------------------------------------------------

/// The active project's path, or a typed error when no project is active.
fn active_project_path(project: &ProjectStore) -> Result<String, String> {
    project
        .active()
        .map(|p| p.path)
        .ok_or_else(|| "no active project".to_string())
}

/// Read the curated context pack for the active project (the Constitution editor's
/// load). `Ok(None)` when no project is active or no `context.md` exists yet.
#[tauri::command]
pub fn get_context_pack(project: State<'_, ProjectStore>) -> Result<Option<String>, String> {
    match project.active() {
        Some(p) => Ok(read_pack(&p.path)),
        None => Ok(None),
    }
}

/// Persist the curated context pack for the active project (the Constitution editor's
/// save).
#[tauri::command]
pub fn set_context_pack(
    project: State<'_, ProjectStore>,
    content: String,
) -> Result<(), String> {
    let path = active_project_path(&project)?;
    write_pack(&path, &content)
}

/// Re-assemble the default pack from on-disk sources, persist it as `context.md`, and
/// return the new content (the "regenerate from sources" action). Overwrites the
/// curated file with a fresh assembly the user can then re-edit.
#[tauri::command]
pub fn regenerate_context_pack(project: State<'_, ProjectStore>) -> Result<String, String> {
    let path = active_project_path(&project)?;
    let content = assemble_default(&path);
    write_pack(&path, &content)?;
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn project_root() -> TempDir {
        TempDir::new().expect("create temp dir")
    }

    #[test]
    fn read_pack_round_trips_through_disk() {
        let tmp = project_root();
        let path = tmp.path().to_string_lossy().to_string();

        // Absent file ⇒ None (the pre-feature "nothing injected" shape).
        assert!(read_pack(&path).is_none());

        // Written content reads back verbatim.
        write_pack(&path, "PROJECT CONSTITUTION\n\nkeep tests green").expect("write");
        let got = read_pack(&path).expect("read back the curated pack");
        assert!(got.contains("PROJECT CONSTITUTION"));
        assert!(got.contains("keep tests green"));

        // The file lives at the Nightcore-owned path.
        assert!(tmp.path().join(".nightcore/context.md").exists());
    }

    #[test]
    fn read_pack_treats_blank_as_none() {
        let tmp = project_root();
        let path = tmp.path().to_string_lossy().to_string();
        write_pack(&path, "   \n\t\n").expect("write blank");
        assert!(
            read_pack(&path).is_none(),
            "a whitespace-only context.md injects nothing"
        );
    }

    #[test]
    fn assemble_default_gathers_constitution_and_memory_sorted() {
        let tmp = project_root();
        let root = tmp.path();
        let path = root.to_string_lossy().to_string();

        std::fs::write(root.join("CLAUDE.md"), "# Repo rules\nfolder-per-component")
            .expect("write CLAUDE.md");
        std::fs::write(root.join("AGENTS.md"), "agents: be careful").expect("write AGENTS.md");
        let mem = root.join(".nightcore/memory");
        std::fs::create_dir_all(&mem).expect("mkdir memory");
        // Out-of-order names to prove deterministic sorting.
        std::fs::write(mem.join("b_second.md"), "second note").expect("write mem b");
        std::fs::write(mem.join("a_first.md"), "first note").expect("write mem a");
        std::fs::write(mem.join("ignore.txt"), "not markdown").expect("write non-md");

        let pack = assemble_default(&path);
        assert!(pack.contains("Project Constitution (CLAUDE.md)"));
        assert!(pack.contains("folder-per-component"));
        assert!(pack.contains("Project Constitution (AGENTS.md)"));
        assert!(pack.contains("Project Memory"));
        // Non-markdown is excluded.
        assert!(!pack.contains("not markdown"));
        // Memory files are ordered by name: a_first before b_second.
        let first_at = pack.find("a_first.md").expect("a present");
        let second_at = pack.find("b_second.md").expect("b present");
        assert!(first_at < second_at, "memory files sort by name");
    }

    #[test]
    fn assemble_default_with_no_sources_is_a_friendly_placeholder() {
        let tmp = project_root();
        let path = tmp.path().to_string_lossy().to_string();
        let pack = assemble_default(&path);
        // Still a valid, non-empty pack the user can edit — never an empty string.
        assert!(pack.contains("Pre-flight Context Pack"));
        assert!(pack.contains("No on-disk sources found"));
    }

    #[test]
    fn regenerate_writes_the_assembled_default_to_disk() {
        // The regenerate path assembles + persists; a subsequent read returns it.
        let tmp = project_root();
        let root = tmp.path();
        let path = root.to_string_lossy().to_string();
        std::fs::write(root.join("CLAUDE.md"), "rule: no unwrap").expect("write CLAUDE.md");

        let assembled = assemble_default(&path);
        write_pack(&path, &assembled).expect("persist assembled");
        let reloaded = read_pack(&path).expect("read back");
        assert_eq!(reloaded, assembled, "regenerate persists what it assembled");
        assert!(reloaded.contains("no unwrap"));
    }
}
