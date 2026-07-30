//! The harness policy authoring commands (the hardening catalog's policy UI seam).
//!
//! `.nightcore/harness.json`'s `policy` block is Rust-read/-written ONLY — never
//! model output. These commands give the web a typed read
//! (`get_harness_policy_file`) and a merge-by-key write
//! (`update_harness_policy_file`) over the ACTIVE project's manifest. The path is
//! always resolved server-side from the active project — never caller-supplied —
//! so the webview cannot point the writer at an arbitrary file. The reader/writer
//! themselves live in [`crate::store::harness_manifest`] (the single manifest
//! seam — audit #35); this module is the thin command shell the layer charter
//! (`commands/mod.rs`) calls for.
//!
//! `list_policy_activity` (issue #400) is the read-only third command: the
//! project's rails used to be invisible until the moment they parked a task, so
//! the authoring surface now reads the flight recorder back as a
//! why-denied-attributed feed. The aggregator lives in
//! [`crate::store::policy_activity`].

use tauri::AppHandle;

use crate::store::governance;
use crate::store::harness_manifest::{
    read_policy_file, write_policy_patch, HarnessPolicyFile, HarnessPolicyPatch,
};
use crate::store::policy_activity::{read_policy_activity, PolicyActivityEntry};

// --- Commands ---------------------------------------------------------------

/// The active project's path via `try_state` (blocking-pool safe: an unmanaged
/// store fails gracefully instead of panicking off the main thread).
fn active_project_path(app: &AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let projects = app
        .try_state::<crate::project::ProjectStore>()
        .ok_or_else(|| "project store unavailable".to_string())?;
    projects
        .active()
        .map(|p| p.path)
        .ok_or_else(|| "no active project".to_string())
}

/// Read the ACTIVE project's harness policy block for the editor UI. Async +
/// `spawn_blocking`: file IO must not stall the WKWebView (same posture as
/// `scan_injection_surface`).
#[tauri::command]
pub async fn get_harness_policy_file(app: AppHandle) -> Result<HarnessPolicyFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = active_project_path(&app)?;
        Ok(read_policy_file(&path))
    })
    .await
    .map_err(|e| format!("policy read failed to run: {e}"))?
}

/// The ACTIVE project's recent gate decisions (deny/ask), newest first — the
/// Policy activity feed (issue #400).
///
/// Read-only: it aggregates the flight-recorder ledgers the engine already wrote
/// and never touches the manifest. The project root is resolved server-side from
/// the active project (never caller-supplied), so the webview cannot point the
/// reader at an arbitrary directory. Task titles are resolved through the task
/// store for legibility; a task deleted since its session keeps its evidence
/// without a title. Async + `spawn_blocking`: it reads one file per task, which
/// must not stall the WKWebView (`reference_tauri_command_threading`).
#[tauri::command]
pub async fn list_policy_activity(app: AppHandle) -> Result<Vec<PolicyActivityEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let root = active_project_path(&app)?;
        let dir = crate::store::ledger::ledger_dir(std::path::Path::new(&root));
        // `try_state` inside the blocking closure (the `State<'_>` guard cannot
        // cross into it); an unmanaged store degrades to untitled rows rather
        // than dropping the feed.
        let tasks = app.try_state::<crate::store::TaskStore>();
        let resolve = |task_id: &str| {
            tasks
                .as_ref()
                .and_then(|store| store.get(task_id))
                .map(|task| task.title)
        };
        Ok(read_policy_activity(&dir, &resolve))
    })
    .await
    .map_err(|e| format!("policy activity read failed to run: {e}"))?
}

/// Merge a policy patch into the ACTIVE project's `.nightcore/harness.json`
/// (creating it when absent) and return the updated policy. The target path is
/// resolved server-side — never caller-supplied.
///
/// A successful save is journaled to the project's governance ledger (#399): the
/// manifest is a silent overwrite, so without this nothing durable records that the
/// rails changed. Journaling happens HERE rather than in the manifest writer both
/// because this is where the before/after pair exists and because the writer is a
/// leaf the gauntlet's lenient readers share.
#[tauri::command]
pub async fn update_harness_policy_file(
    app: AppHandle,
    patch: HarnessPolicyPatch,
) -> Result<HarnessPolicyFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = active_project_path(&app)?;
        let before = read_policy_file(&path);
        let after = write_policy_patch(&path, &patch)?;
        journal_policy_save(&path, &before, &after);
        Ok(after)
    })
    .await
    .map_err(|e| format!("policy write failed to run: {e}"))?
}

/// Record what a policy save changed: always a `policy-save`, plus a `quarantine`
/// when the save ADDED denied-read paths — that is exactly the injection-scan
/// card's quarantine action, and the event the `TrustReport.quarantine` seam was
/// left open for. Best-effort (see `store::governance::append`).
fn journal_policy_save(project_path: &str, before: &HarnessPolicyFile, after: &HarnessPolicyFile) {
    let root = std::path::Path::new(project_path);
    governance::append(
        root,
        governance::KIND_POLICY_SAVE,
        &policy_save_summary(after),
        &[],
    );

    let quarantined = governance::added_entries(&before.deny_read_paths, &after.deny_read_paths);
    if !quarantined.is_empty() {
        governance::append(
            root,
            governance::KIND_QUARANTINE,
            &format!("quarantined {} path(s) from agent reads", quarantined.len()),
            &quarantined,
        );
    }
}

/// The one-line shape of a saved policy: whether the layer is armed and how many
/// rules each tier holds. COUNTS, never the patterns themselves — a journal entry
/// is a receipt, not a copy of the config (which is one `git`-less file away
/// anyway), and counts cannot smuggle anything.
fn policy_save_summary(policy: &HarnessPolicyFile) -> String {
    format!(
        "policy saved — {}, {} protected path(s), {} bash denial(s), {} denied read(s), \
         tools {}/{}/{} (deny/ask/allow){}",
        if policy.enabled { "armed" } else { "DISARMED" },
        policy.protected_paths.len(),
        policy.deny_bash_patterns.len(),
        policy.deny_read_paths.len(),
        policy.disallowed_tools.len(),
        policy.ask_tools.len(),
        policy.allow_tools.len(),
        if policy.diff_budget.is_some() {
            ", diff budget set"
        } else {
            ""
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::governance::{read_journal, KIND_POLICY_SAVE, KIND_QUARANTINE};

    fn policy(deny_read: &[&str]) -> HarnessPolicyFile {
        HarnessPolicyFile {
            enabled: true,
            protected_paths: Vec::new(),
            deny_bash_patterns: Vec::new(),
            deny_read_paths: deny_read.iter().map(|s| s.to_string()).collect(),
            disallowed_tools: Vec::new(),
            allow_tools: Vec::new(),
            ask_tools: Vec::new(),
            allow_exec_sinks: Vec::new(),
            diff_budget: None,
            manifest_exists: true,
        }
    }

    #[test]
    fn a_save_records_counts_and_the_armed_state_but_never_the_patterns() {
        let mut armed = policy(&["secrets/**"]);
        armed.protected_paths = vec!["migrations/**".into(), "bun.lock".into()];
        armed.deny_bash_patterns = vec!["git push --force".into()];
        armed.ask_tools = vec!["WebFetch".into()];
        let summary = policy_save_summary(&armed);
        assert!(summary.contains("armed"), "{summary}");
        assert!(summary.contains("2 protected path(s)"), "{summary}");
        assert!(summary.contains("1 bash denial(s)"), "{summary}");
        assert!(summary.contains("1 denied read(s)"), "{summary}");
        assert!(summary.contains("tools 0/1/0"), "{summary}");
        // The receipt carries COUNTS, never the rule text itself.
        assert!(!summary.contains("migrations"), "{summary}");
        assert!(!summary.contains("git push"), "{summary}");

        let mut disarmed = policy(&[]);
        disarmed.enabled = false;
        assert!(policy_save_summary(&disarmed).contains("DISARMED"));
    }

    /// A save that ADDS denied-read paths is the quarantine action — it must land a
    /// `quarantine` record naming the paths, on top of the `policy-save` receipt.
    #[test]
    fn a_save_that_adds_denied_reads_journals_a_quarantine() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let root = tmp.path();

        journal_policy_save(
            &root.to_string_lossy(),
            &policy(&["secrets/**"]),
            &policy(&["secrets/**", "docs/injected.md", "vendor/evil.js"]),
        );

        let read = read_journal(root);
        assert_eq!(read.corrupt_lines, 0);
        assert_eq!(
            read.events
                .iter()
                .map(|e| e.kind.as_str())
                .collect::<Vec<_>>(),
            vec![KIND_POLICY_SAVE, KIND_QUARANTINE],
            "the save receipt leads, the quarantine it produced follows"
        );
        let quarantine = &read.events[1];
        assert!(quarantine.summary.contains("2 path(s)"), "{quarantine:?}");
        assert_eq!(
            quarantine.detail,
            vec!["docs/injected.md", "vendor/evil.js"],
            "only the ADDED paths are named"
        );
    }

    /// A save that changes nothing about denied reads still records the save, but
    /// must NOT claim a quarantine happened.
    #[test]
    fn a_save_without_new_denied_reads_records_no_quarantine() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let root = tmp.path();

        journal_policy_save(
            &root.to_string_lossy(),
            &policy(&["secrets/**"]),
            &policy(&["secrets/**"]),
        );

        let read = read_journal(root);
        assert_eq!(read.events.len(), 1);
        assert_eq!(read.events[0].kind, KIND_POLICY_SAVE);
    }
}
