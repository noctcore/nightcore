//! The Rust HOST end of the path-less, `councilRunId`-keyed engine↔host worktree seam
//! (issue #383) — the security-critical half of the write-capable Council.
//!
//! The in-engine Council drives its debate + its single writer in the sidecar PROCESS; the
//! isolated worktrees, the commit single-flight, and the Structure-Lock gauntlet all live
//! HERE, in the Rust host, already audited by the board. The engine reaches them across the
//! process boundary by emitting a `worktree-op-required { requestId, op, councilRunId }`
//! event; [`handle_worktree_op`] performs the op and replies with a `resolve-worktree-op`
//! command, modeled on the parked-permission seam.
//!
//! **SECURITY INVARIANT — the host DERIVES every path; the engine sends NONE.** The request
//! carries only a closed `op` verb + the `councilRunId`. The host maps that id — via the
//! [`CouncilRunRegistry`] the WEBVIEW populated at `start-council` — to the TRUSTED project
//! root it recorded, and derives the worktree path from it with
//! [`crate::worktree::worktree_path`]. An UNKNOWN or non-build-capable run id is refused
//! outright, and no path is ever taken from the engine, so an injection-compromised engine
//! can name a verb + a run id but can NEVER redirect an op outside
//! `.nightcore/worktrees/<runId>` (the escape guard, `worktree::path::is_under`). This is
//! what makes the seam add a MESSAGE TYPE, not a write/exec sink.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::contracts::{CouncilPresetId, SurfaceCommand};
use crate::provider::SidecarProvider;
use crate::store::types::StructureLockResult;
use crate::workflow::merge::{commit_in_flight, TaskLease};

/// Whether a Council preset WRITES code (declares a `build` stage + an objective gate) —
/// the ONLY presets whose runs may reach a worktree op. `research` is pure-reasoning and is
/// refused (defence in depth: the engine also never emits a worktree op for it). Kept in
/// sync with the engine presets (`ui-bug` #367, `coding` #368).
pub(crate) fn preset_is_build_capable(preset_id: &CouncilPresetId) -> bool {
    matches!(preset_id, CouncilPresetId::UiBug | CouncilPresetId::Coding)
}

/// A host-trusted binding of `councilRunId → (project root, build-capable)`, populated at
/// `start-council` from the WEBVIEW-supplied project path. It is the SOLE authority the
/// worktree-op handler consults for the project root — the engine only NAMES a run over the
/// wire, so it can never influence WHERE a worktree op lands. In-memory (a restart forgets
/// parked runs; a re-`start-council` re-registers), like the pr-fix registry.
#[derive(Default)]
pub(crate) struct CouncilRunRegistry {
    runs: Mutex<HashMap<String, CouncilRunInfo>>,
}

struct CouncilRunInfo {
    project_path: PathBuf,
    build_capable: bool,
}

impl CouncilRunRegistry {
    /// Record a run's TRUSTED project root at `start-council`. Only called with a project
    /// path the webview supplied; the value is never taken from the engine.
    pub(crate) fn register(&self, run_id: &str, project_path: PathBuf, build_capable: bool) {
        crate::sync::lock_or_recover(&self.runs).insert(
            run_id.to_string(),
            CouncilRunInfo {
                project_path,
                build_capable,
            },
        );
    }

    /// The TRUSTED project root for a BUILD-CAPABLE run, or `None` for an unknown run OR a
    /// non-build-capable preset. This is the security gate: a worktree op only proceeds for a
    /// run the host itself registered as build-capable, so a compromised engine naming a
    /// research / foreign / forged run id gets no path derived at all.
    pub(crate) fn build_project_path(&self, run_id: &str) -> Option<PathBuf> {
        let guard = crate::sync::lock_or_recover(&self.runs);
        guard
            .get(run_id)
            .filter(|info| info.build_capable)
            .map(|info| info.project_path.clone())
    }

    /// Drop a run's binding when it closes (a human verdict or a kill). Idempotent.
    pub(crate) fn forget(&self, run_id: &str) {
        crate::sync::lock_or_recover(&self.runs).remove(run_id);
    }

    #[cfg(test)]
    pub(crate) fn is_registered(&self, run_id: &str) -> bool {
        crate::sync::lock_or_recover(&self.runs).contains_key(run_id)
    }
}

/// The host's reply payload for one worktree op — the FLAT per-op result mirrored by the
/// `resolve-worktree-op` command. Built by [`perform_worktree_op`] and dispatched back to
/// the engine, which resolves the awaiting driver / gauntlet call by `requestId`.
struct WorktreeReply {
    request_id: String,
    worktree_path: Option<String>,
    gauntlet_passed: Option<bool>,
    gauntlet_summary: Option<String>,
    error: Option<String>,
}

impl WorktreeReply {
    fn base(request_id: &str) -> Self {
        Self {
            request_id: request_id.to_string(),
            worktree_path: None,
            gauntlet_passed: None,
            gauntlet_summary: None,
            error: None,
        }
    }

    /// A refused / failed op — the awaiting engine call fails CLOSED on `error`.
    fn error(request_id: &str, message: impl Into<String>) -> Self {
        Self {
            error: Some(message.into()),
            ..Self::base(request_id)
        }
    }

    /// `commit` success (no payload — absent `error` ⇒ committed).
    fn ok(request_id: &str) -> Self {
        Self::base(request_id)
    }

    /// `allocate` success — the host-derived worktree dir.
    fn allocated(request_id: &str, worktree_path: String) -> Self {
        Self {
            worktree_path: Some(worktree_path),
            ..Self::base(request_id)
        }
    }

    /// `gauntlet` result — a pass/fail + a one-line summary recorded beside the verdict.
    fn gauntlet(request_id: &str, passed: bool, summary: String) -> Self {
        Self {
            gauntlet_passed: Some(passed),
            gauntlet_summary: Some(summary),
            ..Self::base(request_id)
        }
    }

    fn into_command(self) -> SurfaceCommand {
        SurfaceCommand::ResolveWorktreeOp {
            request_id: self.request_id,
            worktree_path: self.worktree_path,
            gauntlet_passed: self.gauntlet_passed,
            gauntlet_summary: self.gauntlet_summary,
            error: self.error,
        }
    }
}

/// Handle one `worktree-op-required` event: derive the TRUSTED project root from the run id,
/// perform the op off the reader thread (git/gauntlet work BLOCKS), and dispatch the
/// `resolve-worktree-op` reply back to the engine. Never panics the reader — a malformed
/// event, an unknown run, or a panicked op all resolve to a logged reply.
pub(crate) async fn handle_worktree_op(app: &AppHandle, event: Value) {
    let request_id = event
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let op = event.get("op").and_then(Value::as_str).map(str::to_string);
    let council_run_id = event
        .get("councilRunId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let (Some(request_id), Some(op), Some(council_run_id)) = (request_id, op, council_run_id)
    else {
        tracing::warn!(target: "nightcore::council", "worktree-op-required missing requestId/op/councilRunId; dropping");
        return;
    };

    // The SOLE authority for the project root — never the engine (the escape guard). An
    // unknown / non-build-capable run yields no path and is refused.
    let project_path = app
        .state::<CouncilRunRegistry>()
        .build_project_path(&council_run_id);

    let reply = match project_path {
        None => {
            tracing::warn!(target: "nightcore::council", council_run_id = %council_run_id, op = %op, "refusing a worktree op for an unknown / non-build-capable council run");
            WorktreeReply::error(&request_id, "unknown or non-build-capable council run")
        }
        Some(project_path) => {
            // The worktree path is DERIVED host-side from the trusted (project_path,
            // councilRunId) inside `perform_worktree_op` — the engine sends none. Offloaded
            // to the blocking pool: `git worktree add` / commit / the whole Structure-Lock
            // gauntlet all block, so they must not run on the async runtime thread.
            let op_for_blocking = op.clone();
            let run_for_blocking = council_run_id.clone();
            let request_for_blocking = request_id.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                perform_worktree_op(
                    &op_for_blocking,
                    &project_path,
                    &run_for_blocking,
                    &request_for_blocking,
                )
            })
            .await
            {
                Ok(reply) => reply,
                Err(e) => {
                    tracing::error!(target: "nightcore::council", council_run_id = %council_run_id, op = %op, error = %e, "worktree op panicked on the blocking pool");
                    WorktreeReply::error(&request_id, "the worktree op failed unexpectedly")
                }
            }
        }
    };

    let provider = app.state::<Arc<SidecarProvider>>();
    if let Err(e) = provider.dispatch_command(reply.into_command()).await {
        tracing::warn!(target: "nightcore::council", request_id = %request_id, error = %e, "failed to dispatch resolve-worktree-op back to the engine");
    }
}

/// Perform ONE worktree op against the TRUSTED, host-derived path. Runs on the blocking
/// pool. Every op is confined to `<project>/.nightcore/worktrees/<councilRunId>`:
///  - `allocate` — `crate::worktree::allocate` (idempotent; branch `nc/<runId>`).
///  - `commit`   — `crate::worktree::commit` under the SAME `commit_in_flight` single-flight
///    lease board commits use; NEVER a merge (merge/discard stay human-only). The message is
///    host-synthesized so no engine text reaches git.
///  - `gauntlet` — `crate::gauntlet_project::run_from(project_root, worktree)`: the board's
///    audited worktree gate — the manifest is loaded from the TRUSTED project root while the
///    checks run in the worktree, so a write-capable writer cannot redefine which checks run.
fn perform_worktree_op(
    op: &str,
    project_path: &Path,
    council_run_id: &str,
    request_id: &str,
) -> WorktreeReply {
    match op {
        "allocate" => match crate::worktree::allocate(project_path, council_run_id) {
            Ok(dir) => WorktreeReply::allocated(request_id, dir.to_string_lossy().into_owned()),
            Err(e) => WorktreeReply::error(request_id, format!("worktree allocation failed: {e}")),
        },
        "commit" => {
            // Single-flight on the shared commit lease, keyed on the run id — a council
            // commit never races a concurrent commit for the same id (defence in depth
            // behind the engine's serial build turn).
            let Some(_lease) = TaskLease::acquire(commit_in_flight(), council_run_id) else {
                return WorktreeReply::error(
                    request_id,
                    "another commit is already in flight for this run",
                );
            };
            let message = format!("Council build (run {council_run_id})");
            match crate::worktree::commit(project_path, council_run_id, &message) {
                Ok(_) => WorktreeReply::ok(request_id),
                Err(e) => WorktreeReply::error(request_id, format!("worktree commit failed: {e}")),
            }
        }
        "gauntlet" => {
            // Manifest from the TRUSTED project root; checks in the run's worktree — BOTH
            // host-derived from the run id (never engine-sent). Reuses the board's runner.
            let run_dir = crate::worktree::worktree_path(project_path, council_run_id);
            if !run_dir.exists() {
                return WorktreeReply::gauntlet(
                    request_id,
                    false,
                    "the worktree was not allocated before the gate ran".to_string(),
                );
            }
            let result = crate::gauntlet_project::run_from(project_path, &run_dir);
            let summary = gauntlet_summary(&result);
            WorktreeReply::gauntlet(request_id, result.passed, summary)
        }
        other => WorktreeReply::error(request_id, format!("unsupported worktree op {other:?}")),
    }
}

/// A one-line, human-readable Structure-Lock summary recorded beside the gate verdict on the
/// transcript — mirrors the engine's `gauntletObjectiveGate` summary style.
fn gauntlet_summary(result: &StructureLockResult) -> String {
    if result.passed {
        format!(
            "Structure-Lock gauntlet passed ({} check(s)).",
            result.checks.len()
        )
    } else {
        match &result.failed_check {
            Some(check) => format!("Structure-Lock gauntlet FAILED at \"{check}\"."),
            None => "Structure-Lock gauntlet FAILED.".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::{is_under, worktree_path, worktrees_base};

    #[test]
    fn build_capable_presets_are_ui_bug_and_coding_only() {
        assert!(preset_is_build_capable(&CouncilPresetId::UiBug));
        assert!(preset_is_build_capable(&CouncilPresetId::Coding));
        // `research` is pure-reasoning — it must never reach a worktree op.
        assert!(!preset_is_build_capable(&CouncilPresetId::Research));
    }

    #[test]
    fn registry_returns_a_project_root_only_for_a_known_build_capable_run() {
        let registry = CouncilRunRegistry::default();
        registry.register("run-build", PathBuf::from("/proj"), true);
        registry.register("run-research", PathBuf::from("/proj"), false);

        // A known BUILD-CAPABLE run yields its recorded project root.
        assert_eq!(
            registry.build_project_path("run-build"),
            Some(PathBuf::from("/proj"))
        );
        // A known but NON-build-capable (research) run is refused — no path derived.
        assert_eq!(registry.build_project_path("run-research"), None);
        // An UNKNOWN run id is refused — the engine cannot conjure a project root.
        assert_eq!(registry.build_project_path("run-unknown"), None);

        registry.forget("run-build");
        assert_eq!(registry.build_project_path("run-build"), None);
        assert!(!registry.is_registered("run-build"));
    }

    #[test]
    fn a_foreign_or_traversal_run_id_is_refused_not_resolved_to_a_path() {
        // The core security property (acceptance test #4): the host NEVER derives a worktree
        // path from an untrusted run id. A run id the host never registered — including one
        // carrying `../` traversal — resolves to NO project root, so no path is ever computed
        // for it and the op is refused. Only the ids the WEBVIEW registered are honored.
        let registry = CouncilRunRegistry::default();
        registry.register("run-build", PathBuf::from("/proj"), true);

        for forged in [
            "../../etc",
            "run-build/../../escape",
            "/abs/evil",
            "unknown",
        ] {
            assert_eq!(
                registry.build_project_path(forged),
                None,
                "a foreign / traversal run id {forged:?} must be refused, never resolved"
            );
        }
    }

    #[test]
    fn a_registered_runs_worktree_is_derived_strictly_under_the_worktrees_base() {
        // For a REGISTERED run, the worktree path the host derives is `worktree_path(project,
        // runId)` — always strictly under `<project>/.nightcore/worktrees/` (the escape guard
        // `is_under` holds), so even a legitimate op is confined to the run's own worktree.
        let project = Path::new("/proj");
        let derived = worktree_path(project, "run-build");
        let base = worktrees_base(project);
        assert!(
            is_under(&base, &derived),
            "the derived worktree must be strictly under the worktrees base"
        );
        assert_eq!(
            derived,
            PathBuf::from("/proj/.nightcore/worktrees/run-build")
        );
    }
}
