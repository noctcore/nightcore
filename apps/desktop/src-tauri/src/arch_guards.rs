//! Crate-wide architecture guard tests (audit #38) — the Rust analogue of the TS
//! `rust-layer-rank` lint-meta rule, enforced where the toolchain actually lives
//! (the Bun CI lint job has no Tauri deps, so cargo-side invariants gate HERE).
//!
//! Replicates the proven `store/mod.rs` `layer_boundary` pattern: a mechanical,
//! comment-tolerant source scan whose needle literals are `concat!`-hidden so the
//! scanner never flags itself. Two families:
//!
//!  1. LAYER GUARDS — the leaf modules' import surfaces (`worktree/` → git+infra
//!     only, `git/` → infra only) and the two seam-guarded engine edges
//!     (`workflow/` must reach the sidecar only through `Arc<dyn SessionDispatch>`;
//!     `sidecar/` must reach the engine only through `Arc<dyn EngineApi>` — both
//!     closed by audit #33 and kept closed here, in lockstep with the lint-meta
//!     `rust-layer-rank` ENGINE-SCC bans).
//!
//!  2. SYNC-COMMAND ALLOWLIST — every synchronous `#[tauri::command] fn` runs on
//!     the WKWebView main thread (the commit-button-freeze class). Audit #32 moved
//!     the heavy ones to `async` + `spawn_blocking`; this ratchet freezes the
//!     cheap-in-memory survivor set so adding a NEW sync command (or converting
//!     one to async) is a conscious, reviewed edit to [`tests::SYNC_COMMAND_ALLOWLIST`].

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// Every `.rs` file under `src/<subtree>`, recursively.
    fn sources(subtree: &str) -> Vec<PathBuf> {
        let mut out = Vec::new();
        collect(
            &Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join(subtree),
            &mut out,
        );
        out
    }

    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("read a source dir") {
            let path = entry.expect("read a source dir entry").path();
            if path.is_dir() {
                collect(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// Non-comment lines of `src` that name any of `forbidden`, as
    /// `line: text` offence strings. Comment lines (incl. `//!`/`///`
    /// intra-doc links) name these paths as prose, not imports — skipped.
    fn scan_lines(src: &str, forbidden: &[String]) -> Vec<String> {
        let mut found = Vec::new();
        for (idx, line) in src.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for needle in forbidden {
                if line.contains(needle.as_str()) {
                    found.push(format!("{}: {}", idx + 1, line.trim()));
                }
            }
        }
        found
    }

    /// [`scan_lines`] over every source file under `subtree`, offences prefixed
    /// with the file path.
    fn offences(subtree: &str, forbidden: &[String]) -> Vec<String> {
        let mut found = Vec::new();
        for file in sources(subtree) {
            let src = std::fs::read_to_string(&file).expect("read a source file");
            for offence in scan_lines(&src, forbidden) {
                found.push(format!("{}:{offence}", file.display()));
            }
        }
        found
    }

    /// Build `crate::<module>` needles with the head hidden from this scanner.
    fn needles(modules: &[&str]) -> Vec<String> {
        modules
            .iter()
            .map(|m| format!("{}::{m}", concat!("cra", "te")))
            .collect()
    }

    /// Everything ABOVE the rank the module may depend on — including the
    /// crate-root facade aliases (`lib.rs`) that would otherwise hide an upward
    /// edge behind `crate::task` / `crate::merge` / `crate::gauntlet`.
    const ABOVE_GIT: &[&str] = &[
        "store",
        "worktree",
        "provider",
        "analysis",
        "orchestration",
        "sidecar",
        "workflow",
        "commands",
        "bindings",
        // store facades
        "project",
        "settings",
        "task",
        "transcript",
        // workflow facades
        "gauntlet",
        "gauntlet_project",
        "kind",
        "merge",
        "plan_approval",
    ];

    #[test]
    fn worktree_imports_only_git_and_infra() {
        // `worktree/` (rank 3) may reach DOWN into `git` (2) and `infra` (1) only;
        // everything at/above its own rank is forbidden (add a seam, not an edge).
        let above: Vec<&str> = ABOVE_GIT
            .iter()
            .copied()
            .filter(|m| !matches!(*m, "worktree"))
            .collect();
        let found = offences("worktree", &needles(&above));
        assert!(
            found.is_empty(),
            "worktree/ may import only crate::git and crate::infra (platform/proc/logging) — \
             route anything else through a seam. Offending line(s):\n{}",
            found.join("\n")
        );
    }

    #[test]
    fn git_imports_only_infra() {
        // `git/` (rank 2) is one step above the infra leaf: `crate::infra` (and its
        // `platform`/`proc`/`logging` facades) is its ONLY internal dependency.
        let found = offences("git", &needles(ABOVE_GIT));
        assert!(
            found.is_empty(),
            "git/ may import only crate::infra (platform/proc/logging) — \
             route anything else through a seam. Offending line(s):\n{}",
            found.join("\n")
        );
    }

    #[test]
    fn workflow_never_imports_sidecar() {
        // Audit #33 broke the workflow ⇄ sidecar cycle: session dispatch goes through
        // the managed `Arc<dyn SessionDispatch>` (engine_api.rs) and the injection
        // fence lives in `infra::untrusted`. A direct import re-closes the cycle.
        let found = offences("workflow", &needles(&["sidecar"]));
        assert!(
            found.is_empty(),
            "workflow/ must reach the sidecar only through Arc<dyn SessionDispatch> \
             (crate::engine_api) — a direct crate::sidecar import re-closes the \
             engine-module cycle audit #33 broke. Offending line(s):\n{}",
            found.join("\n")
        );
    }

    #[test]
    fn sidecar_never_imports_orchestration() {
        // The original engine seam (2026-06-28): the bridge reaches the run engine
        // only through `Arc<dyn EngineApi>`; a direct import re-closes that cycle.
        let found = offences("sidecar", &needles(&["orchestration"]));
        assert!(
            found.is_empty(),
            "sidecar/ must reach the engine only through Arc<dyn EngineApi> \
             (crate::engine_api) — a direct crate::orchestration import re-closes \
             the cycle the engine_api seam breaks. Offending line(s):\n{}",
            found.join("\n")
        );
    }

    #[test]
    fn orchestration_never_branches_on_a_provider_id() {
        // Issue #18 acceptance (Phase 4): capability degradation fires from each
        // provider's `ProviderCapabilities` descriptor, NEVER a `match provider` in
        // orchestration. The one provider-id → implementation mapping lives in
        // `provider::build_provider` (a different subtree); the coordinator only
        // passes the configured id THROUGH to that factory. So no provider-id string
        // literal or comparison may appear anywhere under `orchestration/`. Needles
        // are `concat!`-hidden per the file convention. Referencing the
        // `CLAUDE_PROVIDER_ID` *const* in the factory-fallback is fine — that is not a
        // quoted literal, so it is not a branch.
        let forbidden: Vec<String> = [
            concat!("\"", "claude", "\"").to_string(),
            concat!("\"", "codex", "\"").to_string(),
            concat!("\"", "gemini", "\"").to_string(),
            "provider_id ==".to_string(),
            ".provider ==".to_string(),
            concat!("mat", "ch provider").to_string(),
        ]
        .to_vec();
        let found = offences("orchestration", &forbidden);
        assert!(
            found.is_empty(),
            "orchestration must not branch on a provider id — route provider \
             selection through provider::build_provider, and degrade from the \
             ProviderCapabilities descriptor (issue #18). Offending line(s):\n{}",
            found.join("\n")
        );
    }

    // --- Sync-command allowlist ratchet (audit #38, follows #32) ----------------

    /// The blessed synchronous `#[tauri::command]`s. Every entry is a cheap
    /// in-memory read/mutation (list/get/dismiss/convert-link/settings) whose body
    /// does no git/network work and no unbounded file IO — the heavy ones were
    /// converted to `async` + `spawn_blocking` by audit #32. `$list`/`$get`/
    /// `$delete` are the `scan_lifecycle_commands!` macro templates (stamped once
    /// per scan kind). ADDING a name here is a conscious act: a sync command runs
    /// on the WKWebView main thread and can freeze the UI (the commit-button
    /// incident); prefer the `async fn` + `spawn_blocking` + `try_state` recipe.
    /// The test asserts EXACT equality, so converting a command to async must also
    /// remove its entry (the ratchet only shrinks).
    const SYNC_COMMAND_ALLOWLIST: &[&str] = &[
        "$delete",
        "$get",
        "$list",
        "accept_review",
        "active_project",
        "app_info",
        "arm_harness_gauntlet_check",
        "blocked_task_ids",
        "convert_finding_to_task",
        "convert_harness_finding_to_task",
        "convert_harness_proposal",
        "convert_issue_validation_to_task",
        "convert_reading_to_task",
        "convert_review_finding_to_task",
        "convert_subtask",
        "create_project",
        "create_task",
        "delete_task",
        "dismiss_finding",
        "dismiss_harness_artifact",
        "dismiss_harness_finding",
        "dismiss_harness_proposal",
        "dismiss_pr_fix",
        "dismiss_review_finding",
        "get_context_pack",
        "get_settings",
        "is_git_repo",
        "list_pr_fixes",
        "list_projects",
        "list_tasks",
        "mark_issue_validation_viewed",
        "move_task",
        "open_external",
        "preview_issue_comment",
        "reject_review",
        "remove_task_attachment",
        "rename_project",
        "read_project_icon",
        "set_project_icon",
        "clear_project_icon",
        "update_project",
        "restore_finding",
        "restore_harness_artifact",
        "restore_harness_finding",
        "restore_harness_proposal",
        "restore_review_finding",
        "resume_auto_loop",
        "set_context_pack",
        "set_max_concurrency_cmd",
        "start_auto_loop",
        "stop_auto_loop",
        "update_settings",
        "update_task",
    ];

    /// Extract the fn name following each bare `#[tauri::command]` attribute line
    /// when that fn is NOT `async`. Attribute lines must be exactly the attribute
    /// (the codebase convention), so doc-comment mentions never match; intervening
    /// attributes/comments/blank lines are skipped to find the `fn` line.
    fn sync_command_names() -> Vec<String> {
        let mut found = Vec::new();
        for file in sources(".") {
            let src = std::fs::read_to_string(&file).expect("read a source file");
            let lines: Vec<&str> = src.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if line.trim() != concat!("#[ta", "uri::command]") {
                    continue;
                }
                let mut j = i + 1;
                while j < lines.len() {
                    let s = lines[j].trim();
                    if s.is_empty() || s.starts_with("//") || s.starts_with("#[") {
                        j += 1;
                        continue;
                    }
                    break;
                }
                let Some(sig) = lines.get(j).map(|s| s.trim()) else {
                    continue;
                };
                let sig = sig.strip_prefix("pub(crate) ").unwrap_or(sig);
                let sig = sig.strip_prefix("pub ").unwrap_or(sig);
                if sig.starts_with("async fn ") {
                    continue;
                }
                if let Some(rest) = sig.strip_prefix("fn ") {
                    let name: String = rest
                        .chars()
                        .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
                        .collect();
                    if !name.is_empty() {
                        found.push(name);
                    }
                }
            }
        }
        found.sort();
        found.dedup();
        found
    }

    #[test]
    fn sync_tauri_commands_match_the_allowlist_exactly() {
        let found = sync_command_names();
        let allow: Vec<String> = SYNC_COMMAND_ALLOWLIST
            .iter()
            .map(|s| s.to_string())
            .collect();
        let new: Vec<&String> = found.iter().filter(|n| !allow.contains(n)).collect();
        let stale: Vec<&String> = allow.iter().filter(|n| !found.contains(n)).collect();
        assert!(
            new.is_empty(),
            "NEW synchronous #[tauri::command] fn(s) found: {new:?}. A sync command \
             runs on the WKWebView main thread and can freeze the UI — use the \
             `async fn` + `spawn_blocking` + `try_state` recipe (see commit_task), \
             or consciously add the name to SYNC_COMMAND_ALLOWLIST with a \
             justification."
        );
        assert!(
            stale.is_empty(),
            "stale SYNC_COMMAND_ALLOWLIST entries (command removed or now async): \
             {stale:?}. Remove them so the ratchet keeps shrinking."
        );
    }

    #[test]
    fn scanner_reds_on_a_synthetic_violation_and_tolerates_comments() {
        // Acceptance: the guards must be RED on a violation, GREEN on prose. Feed
        // the shared line scanner a fabricated source with one real import, one
        // doc-comment mention, and one line comment.
        let forbidden = needles(&["sidecar"]);
        let violating = format!(
            "use {}::ensure_reader;\n/// prose about {} stays legal\n// so does {}\n",
            forbidden[0], forbidden[0], forbidden[0]
        );
        let found = scan_lines(&violating, &forbidden);
        assert_eq!(
            found.len(),
            1,
            "exactly the real import line is flagged: {found:?}"
        );
        assert!(
            found[0].starts_with("1:"),
            "the offence is line 1: {found:?}"
        );
    }
}
