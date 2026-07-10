//! The ts-rs export aggregator + its regenerate-and-diff drift guard.
//!
//! Two layers keep the Rust and TS sides from drifting (mirroring the zod→Rust
//! guard in `contracts::mod`):
//!
//!  1. **Export-on-test**: ts-rs emits a hidden test per `#[ts(export)]` type that
//!     writes its binding to disk during `cargo test`. [`export_all_bindings`]
//!     below is an explicit, documented umbrella that exports every boundary type
//!     in one call (and is exercised by [`tests::bindings_export_to_the_web_tree`]),
//!     so the codegen has a single named entry point a human can find.
//!  2. **Regenerate-and-diff** (CI): run `cargo test` to (re)write the bindings,
//!     then assert `git diff --exit-code apps/web/src/lib/generated/` is clean. A
//!     Rust field rename/retype/enum-value change therefore shows up as an
//!     uncommitted binding change and fails the guard LOUDLY — exactly like
//!     `bun run codegen:contracts --check` does for the zod→Rust direction.

use ts_rs::TS;

/// Export every Rust→TS boundary binding to `TS_RS_EXPORT_DIR`
/// (`apps/web/src/lib/generated/`). Idempotent: `cargo test` also exports each type
/// via its own ts-rs-generated test; this is the single documented umbrella so the
/// full boundary set is visible in one place. Panics on an export error so a broken
/// codegen fails the test rather than silently skipping a type.
fn export_all_bindings() {
    use crate::analysis::injection_scan::InjectionFlag;
    use crate::gauntlet::{GauntletResult, GauntletStep};
    use crate::infra::editor::DetectedEditor;
    use crate::orchestration::coordinator::LoopSnapshot;
    use crate::project::Project;
    use crate::settings::{
        AppInfo, BoardAppearance, BoardBackgroundRef, McpServerEntry, McpServerTransport, Settings,
        SettingsOverride, SettingsPatch,
    };
    use crate::sidecar::{ProviderConfigSnapshotView, SessionInfoView, SessionMessageView};
    use crate::store::harness_manifest::{HarnessPolicyFile, HarnessPolicyPatch, PolicyDiffBudget};
    use crate::store::insight::{FindingLocation, InsightRun, InsightUsage, StoredFinding};
    use crate::store::pr_review::{PrReviewRun, StoredReviewFinding};
    use crate::store::scorecard::{ScorecardEvidence, ScorecardRun, StoredReading};
    use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};
    use crate::task::{
        PermissionMode, ProposedSubtask, RunMode, SubtaskStatus, Task, TaskKind, TaskPatch,
        TaskStatus,
    };
    use crate::terminal::{
        PersistedTerminalInfo, PersistedTerminalScrollback, TerminalSessionInfo,
    };
    use crate::workflow::pr::{PrDraft, PrSupport};
    use crate::workflow::pr_changed_files::PrChangedFile;
    use crate::workflow::pr_comments::{PrCommentTriage, PrCommentTriageClass};
    use crate::workflow::pr_fix::PrFixState;
    use crate::workflow::pr_list::{PrLabel, PrSummary};
    use crate::workflow::pr_status::PrStatus;
    use crate::workflow::trust::{
        FlightSummary, GauntletTrust, GuardrailEvent, GuardrailTrust, QuarantineEvent, TokenTotals,
        TrustReport,
    };
    use crate::worktree::{
        BranchInfo, DiffFileStat, DiffStatus, MergePreview, MergePreviewStatus, WorktreeDiff,
        WorktreeDiffFile, WorktreeStatus,
    };

    // `export_all` writes the type AND all of its `TS` dependencies, so exporting
    // the four aggregates (Task, Settings, GauntletResult, the loop snapshot) plus
    // the standalone command/result shapes covers every binding. Calling export on
    // each leaf too is harmless (idempotent) and keeps the list explicit. The
    // `Config::from_env()` reads `TS_RS_EXPORT_DIR` / `TS_RS_LARGE_INT` from
    // `.cargo/config.toml`, matching ts-rs's own auto-generated export tests.
    let cfg = ts_rs::Config::from_env();
    macro_rules! export {
        ($($ty:ty),* $(,)?) => {
            $( <$ty as TS>::export_all(&cfg).expect(concat!("export ", stringify!($ty))); )*
        };
    }
    export!(
        Task,
        TaskPatch,
        TaskStatus,
        TaskKind,
        RunMode,
        PermissionMode,
        // Decompose: the proposed sub-task + its convert lifecycle (also reached
        // transitively via `Task`).
        ProposedSubtask,
        SubtaskStatus,
        Project,
        Settings,
        SettingsOverride,
        SettingsPatch,
        // The MCP server form types (also reached transitively via Settings).
        McpServerEntry,
        McpServerTransport,
        // Custom Background: the per-project board-appearance knobs + image ref (also
        // reached transitively via SettingsOverride).
        BoardAppearance,
        BoardBackgroundRef,
        AppInfo,
        // Worktree open-in-editor: the detected-editor rows for the Settings picker.
        DetectedEditor,
        WorktreeStatus,
        // Worktree overhaul: branch picker + merge-preview + worktree-diff shapes.
        // `export_all` on the aggregates also writes their nested enums/stats.
        BranchInfo,
        MergePreview,
        MergePreviewStatus,
        DiffFileStat,
        WorktreeDiff,
        WorktreeDiffFile,
        DiffStatus,
        GauntletResult,
        GauntletStep,
        StepStatus,
        // Structure-Lock Gauntlet (Verify, feature #3): the per-project harness-gate
        // result + per-check shapes. Also reached transitively via `Task`.
        StructureLockResult,
        StructureLockCheck,
        LoopSnapshot,
        SessionInfoView,
        SessionMessageView,
        // `export_all` writes the snapshot AND its nested section/summary views.
        ProviderConfigSnapshotView,
        // Insight (codebase analysis) persisted shapes. `export_all` on InsightRun
        // writes its nested StoredFinding / FindingLocation / InsightUsage too.
        InsightRun,
        StoredFinding,
        FindingLocation,
        InsightUsage,
        // Readiness Scorecard (Profile) persisted shapes. `export_all` on ScorecardRun
        // writes its nested StoredReading / ScorecardEvidence too (FindingLocation /
        // InsightUsage are shared with Insight).
        ScorecardRun,
        StoredReading,
        ScorecardEvidence,
        // PR Review (GitHub pull-request review) persisted shapes. `export_all` on
        // PrReviewRun writes its nested StoredReviewFinding (→ ReviewFinding.ts) too
        // (InsightUsage is shared with Insight).
        PrReviewRun,
        StoredReviewFinding,
        // Harness policy authoring: the manifest's `policy` block as the editor
        // reads/patches it, plus the injection-scan flag rows it quarantines.
        HarnessPolicyFile,
        HarnessPolicyPatch,
        PolicyDiffBudget,
        InjectionFlag,
        // PR arc (phase 1): the capability probe + the editable draft shape.
        PrSupport,
        PrDraft,
        // PR arc (phase 2): the status-card snapshot.
        PrStatus,
        // PR arc (phase 4): open-PR summaries + labels for the PR Review picker.
        PrLabel,
        PrSummary,
        // PR Review: a PR's changed-file list (path + line deltas) for the detail pane.
        PrChangedFile,
        // PR arc: the address-review-findings fix runner's registry snapshot.
        PrFixState,
        // PR arc (phase 3): the pre-dispatch AI triage of review threads + its class
        // enum (`export_all` on the row writes the nested enum too).
        PrCommentTriage,
        PrCommentTriageClass,
        // The integrated USER terminal: the live-session descriptor + the
        // persisted-scrollback metadata/replay shapes (`export_all` on the
        // scrollback shape also writes the nested `PersistedTerminalInfo`).
        TerminalSessionInfo,
        PersistedTerminalInfo,
        PersistedTerminalScrollback,
        // Trust Report (wayfinder #91): the per-task governance receipt. `export_all`
        // on `TrustReport` also writes its nested section shapes (GauntletTrust /
        // GuardrailTrust / GuardrailEvent / FlightSummary / TokenTotals /
        // QuarantineEvent) and the reused Task enums (already listed above).
        TrustReport,
        GauntletTrust,
        GuardrailTrust,
        GuardrailEvent,
        FlightSummary,
        TokenTotals,
        QuarantineEvent,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The bindings dir, resolved the same way ts-rs resolves `TS_RS_EXPORT_DIR`
    /// from `.cargo/config.toml` (relative to the crate root, which is the cwd
    /// during `cargo test`).
    fn bindings_dir() -> PathBuf {
        let base = std::env::var("TS_RS_EXPORT_DIR").unwrap_or_else(|_| "bindings".to_string());
        PathBuf::from(base)
    }

    /// Running the export writes every boundary binding into the web's source tree.
    /// This is the named entry point of the Rust→TS codegen; the CI drift guard then
    /// asserts `git diff` over the bindings dir is empty after a fresh `cargo test`.
    #[test]
    fn bindings_export_to_the_web_tree() {
        export_all_bindings();

        let dir = bindings_dir();
        // Every boundary type that replaced a bridge.ts hand-mirror must land here.
        for file in [
            "Task.ts",
            "TaskPatch.ts",
            "TaskStatus.ts",
            "TaskKind.ts",
            "RunMode.ts",
            "PermissionMode.ts",
            "ProposedSubtask.ts",
            "SubtaskStatus.ts",
            "Project.ts",
            "Settings.ts",
            "SettingsOverride.ts",
            "SettingsPatch.ts",
            "McpServerEntry.ts",
            "McpServerTransport.ts",
            "BoardAppearance.ts",
            "BoardBackgroundRef.ts",
            "AppInfo.ts",
            "DetectedEditor.ts",
            "WorktreeInfo.ts",
            "BranchInfo.ts",
            "MergePreview.ts",
            "MergePreviewStatus.ts",
            "DiffFileStat.ts",
            "WorktreeDiff.ts",
            "WorktreeDiffFile.ts",
            "DiffStatus.ts",
            "GauntletResult.ts",
            "GauntletStep.ts",
            "StepStatus.ts",
            "StructureLockResult.ts",
            "StructureLockCheck.ts",
            "LoopEnvelope.ts",
            "SessionInfo.ts",
            "SessionMessage.ts",
            "ProviderConfigSnapshot.ts",
            "ProviderConfigSection.ts",
            "McpServerSummary.ts",
            "SkillSummary.ts",
            "SubagentSummary.ts",
            "InsightRun.ts",
            "StoredFinding.ts",
            "FindingLocation.ts",
            "InsightUsage.ts",
            "PrReviewRun.ts",
            "ReviewFinding.ts",
            "HarnessPolicyFile.ts",
            "HarnessPolicyPatch.ts",
            "PolicyDiffBudget.ts",
            "InjectionFlag.ts",
            "PrSupport.ts",
            "PrDraft.ts",
            "PrStatus.ts",
            "PrSummary.ts",
            "PrLabel.ts",
            "PrChangedFile.ts",
            "PrFixState.ts",
            "PrCommentTriage.ts",
            "PrCommentTriageClass.ts",
            "TerminalSessionInfo.ts",
            "PersistedTerminalInfo.ts",
            "PersistedTerminalScrollback.ts",
            "TrustReport.ts",
            "GauntletTrust.ts",
            "GuardrailTrust.ts",
            "GuardrailEvent.ts",
            "FlightSummary.ts",
            "TokenTotals.ts",
            "QuarantineEvent.ts",
        ] {
            assert!(
                dir.join(file).exists(),
                "expected generated binding {file} under {} — did `cargo test` run \
                 the ts-rs export? (TS_RS_EXPORT_DIR={})",
                dir.display(),
                dir.display(),
            );
        }
    }
}
