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
    use crate::commands::checks::{
        ArmedCheck, ArmedCheckOutcome, ArmedChecksLastRun, ArmedChecksState,
    };
    use crate::gauntlet::{GauntletResult, GauntletStep};
    use crate::infra::browse::{DirectoryEntry, DirectoryListing};
    use crate::infra::editor::DetectedEditor;
    use crate::infra::logging::LogLevel;
    use crate::orchestration::coordinator::LoopSnapshot;
    use crate::orchestration::run_order::{RunOrderEntry, RunOrderProjection};
    use crate::project::Project;
    use crate::settings::{
        AppInfo, BoardAppearance, BoardBackgroundRef, McpServerEntry, McpServerTransport, Settings,
        SettingsOverride, SettingsPatch,
    };
    use crate::sidecar::{
        PortableLockExport, ProviderConfigSnapshotView, SessionInfoView, SessionMessageView,
    };
    use crate::store::governance::GovernanceEvent;
    use crate::store::harness_manifest::{
        ArmedCheckFile, HarnessPolicyFile, HarnessPolicyPatch, PolicyDiffBudget,
    };
    use crate::store::insight::{FindingLocation, InsightRun, InsightUsage, StoredFinding};
    use crate::store::policy_activity::PolicyActivityEntry;
    use crate::store::pr_review::{PrReviewRun, StoredReviewFinding};
    use crate::store::scorecard::{ScorecardEvidence, ScorecardRun, StoredReading};
    use crate::store::types::{
        ConventionDrift, StepStatus, StructureLockCheck, StructureLockResult,
    };
    use crate::task::{
        PermissionMode, ProposedSubtask, RunMode, SubtaskStatus, Task, TaskKind, TaskPatch,
        TaskStatus,
    };
    use crate::terminal::governance::TerminalGovernanceReason;
    use crate::terminal::{
        PersistedTerminalInfo, PersistedTerminalScrollback, TerminalDaemonStatus,
        TerminalSessionInfo, TitleSource,
    };
    use crate::usage::contract::{
        Credits, ProviderUsage, RateWindow, UsageCost, UsageMeter, UsageStatus,
    };
    use crate::workflow::issue_map::{
        GroupCount, GroupIntro, IssueMapPreview, IssueMapResult, Narrative, PriorMap,
        SubIssuePreview,
    };
    use crate::workflow::pr::{PrDraft, PrSupport};
    use crate::workflow::pr_changed_files::PrChangedFile;
    use crate::workflow::pr_comments::{PrCommentTriage, PrCommentTriageClass};
    use crate::workflow::pr_fix::PrFixState;
    use crate::workflow::pr_list::{PrLabel, PrSummary};
    use crate::workflow::pr_status::PrStatus;
    use crate::workflow::project_trust::{
        GauntletTotals, GuardrailTotals, JournalSummary, MergeTotals, ProjectTrustSummary,
        RuleTally, SpendTotals, TrustBadge,
    };
    use crate::workflow::trust::{
        FlightSummary, GauntletTrust, GuardrailEvent, GuardrailTrust, QuarantineEvent, TokenTotals,
        TrustReport,
    };
    use crate::worktree::{
        BranchInfo, DiffFileStat, DiffStatus, MergePreview, MergePreviewStatus,
        UpdateFromBaseStatus, WorktreeDiff, WorktreeDiffFile, WorktreeStatus,
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
        // #245: the log-verbosity vocabulary that narrows the `logLevel` Settings
        // field (also reached transitively via Settings/SettingsPatch).
        LogLevel,
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
        // T13: the "Update from base" action outcome.
        UpdateFromBaseStatus,
        GauntletResult,
        GauntletStep,
        StepStatus,
        // Structure-Lock Gauntlet (Verify, feature #3): the per-project harness-gate
        // result + per-check shapes. Also reached transitively via `Task`.
        StructureLockResult,
        StructureLockCheck,
        LoopSnapshot,
        // Board flow (#402): the coordinator's projected execution order — the board's
        // "next up" ordering, per-card position chip, and Auto-Mode arm preview.
        // `export_all` on the projection also writes the nested entry row.
        RunOrderProjection,
        RunOrderEntry,
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
        // Policy activity feed (issue #400): one attributed deny/ask decision read
        // back out of the flight recorder.
        PolicyActivityEntry,
        // Per-project governance journal (issue #399): one append-only record of a
        // human governance decision (quarantine / policy-save / arm / disarm /
        // ratchet) read back off `.nightcore/ledger/project.ndjson`.
        GovernanceEvent,
        // Project trust dashboard (issue #399): the repo-scoped, COMPUTED-ON-DEMAND
        // governance summary + its shields-compatible badge. `export_all` on
        // `ProjectTrustSummary` also writes its nested section shapes (and reaches
        // `GovernanceEvent`, listed above, through the journal roll-up).
        ProjectTrustSummary,
        MergeTotals,
        GauntletTotals,
        GuardrailTotals,
        RuleTally,
        SpendTotals,
        JournalSummary,
        TrustBadge,
        // Checks Manager (Enforce, T7): the armed-check manifest descriptor + the
        // list view (checks with folded last results + the run-level summary).
        ArmedCheckFile,
        ArmedCheck,
        ArmedCheckOutcome,
        ArmedChecksLastRun,
        ArmedChecksState,
        // Drift-v1 (T15): the per-convention drift record an EnforceRun produces (also
        // reached transitively via `ArmedChecksState.drift`).
        ConventionDrift,
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
        // scrollback shape also writes the nested `PersistedTerminalInfo`) + the
        // tab-title precedence source (round-2 PR A).
        TerminalSessionInfo,
        PersistedTerminalInfo,
        PersistedTerminalScrollback,
        TitleSource,
        // The persisted ungoverned-marker reason (#405) — why a terminal is marked as
        // running outside the gates, and whether that marker is revocable.
        TerminalGovernanceReason,
        // Detached PTY daemon (cockpit spec PR 6): the informational status shape.
        TerminalDaemonStatus,
        // Terminal folder browser: the one-level directory listing + its entries
        // (`export_all` on the listing also writes the nested `DirectoryEntry`).
        DirectoryListing,
        DirectoryEntry,
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
        // Issue-map export (wayfinder #112): the preview payload + the write result.
        // `export_all` on `IssueMapPreview` also writes its nested SubIssuePreview /
        // GroupCount / PriorMap / Narrative (→ IssueMapNarrative.ts) / GroupIntro.
        IssueMapPreview,
        SubIssuePreview,
        GroupCount,
        PriorMap,
        GroupIntro,
        Narrative,
        IssueMapResult,
        // Portable Structure-Lock export (#134 PR 3): the staging-bundle descriptor the
        // Enforce-stage "Export portable lock" button renders (staging path + files +
        // workflow YAML + pinned runner version).
        PortableLockExport,
        // Provider usage meter (issue #121): the whole-meter snapshot + per-provider
        // row + window/credits/status shapes, plus the popover-only cost estimate.
        // `export_all` on `UsageMeter` also writes its nested `ProviderUsage` /
        // `RateWindow` / `Credits` / `UsageStatus`; `UsageCost` reuses the Trust
        // Report's `TokenTotals` (already listed above).
        UsageMeter,
        ProviderUsage,
        RateWindow,
        Credits,
        UsageStatus,
        UsageCost,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The message every wrong-cwd failure in this module points at.
    const WRONG_CWD: &str = "\
cargo did not read apps/desktop/src-tauri/.cargo/config.toml, so ts-rs has no \
TS_RS_EXPORT_DIR / TS_RS_LARGE_INT. Cargo discovers .cargo/config.toml by walking up \
from the CURRENT WORKING DIRECTORY, not from --manifest-path: run cargo with \
cwd = apps/desktop/src-tauri (`bun run test:rust` / `bun run check:rust` both do). \
Otherwise the bindings land in the gitignored crate-default bindings/ as bigint and \
the CI drift guard (`git diff --exit-code -- apps/web/src/lib/generated`) passes \
VACUOUSLY, because nothing was written to the directory it guards — issue #422.";

    /// The bindings dir, resolved the same way ts-rs resolves `TS_RS_EXPORT_DIR`
    /// from `.cargo/config.toml` (relative to the crate root, which is the cwd
    /// during `cargo test`).
    ///
    /// Deliberately NOT falling back to ts-rs's crate-default `bindings/`: that
    /// fallback is exactly what let the drift guard pass vacuously for the whole
    /// life of the two local entry points (#422). Panic instead, so a wrong-cwd
    /// invocation is a LOUD red naming its own fix.
    fn bindings_dir() -> PathBuf {
        let base = std::env::var("TS_RS_EXPORT_DIR").expect(WRONG_CWD);
        PathBuf::from(base)
    }

    /// The ts-rs codegen env is a precondition of the drift guard, not a nicety:
    /// with `TS_RS_EXPORT_DIR` unset the export writes somewhere gitignored (guard
    /// vacuous), and with `TS_RS_LARGE_INT` unset every `u64`/`i64` emits `bigint`
    /// where the bridge expects `number` (wrong bindings). Assert BOTH here so the
    /// failure is a named test rather than a mysterious diff.
    #[test]
    fn ts_rs_export_env_targets_the_web_tree() {
        assert_eq!(
            std::env::var("TS_RS_LARGE_INT").as_deref(),
            Ok("number"),
            "{WRONG_CWD}"
        );

        let dir = bindings_dir();
        assert!(
            dir.is_absolute(),
            "TS_RS_EXPORT_DIR should be the absolute path cargo resolves from \
             `relative = true`, got {}. {WRONG_CWD}",
            dir.display(),
        );
        // `apps/desktop/src-tauri/../../web/src/lib/generated` — the ONE directory
        // the CI drift guard diffs. Compared canonically so a `..`-laden or
        // symlinked spelling still matches.
        let expected = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../web/src/lib/generated")
            .canonicalize()
            .expect("apps/web/src/lib/generated must exist");
        assert_eq!(
            dir.canonicalize().expect("TS_RS_EXPORT_DIR must exist"),
            expected,
            "ts-rs is exporting outside the directory the drift guard diffs. {WRONG_CWD}",
        );
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
            "LogLevel.ts",
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
            "UpdateFromBaseStatus.ts",
            "GauntletResult.ts",
            "GauntletStep.ts",
            "StepStatus.ts",
            "StructureLockResult.ts",
            "StructureLockCheck.ts",
            "LoopEnvelope.ts",
            "RunOrderProjection.ts",
            "RunOrderEntry.ts",
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
            "PolicyActivityEntry.ts",
            "ArmedCheckFile.ts",
            "ArmedCheck.ts",
            "ArmedCheckOutcome.ts",
            "ArmedChecksLastRun.ts",
            "ArmedChecksState.ts",
            "ConventionDrift.ts",
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
            "TitleSource.ts",
            "TerminalGovernanceReason.ts",
            "TerminalDaemonStatus.ts",
            "DirectoryListing.ts",
            "DirectoryEntry.ts",
            "TrustReport.ts",
            "GauntletTrust.ts",
            "GuardrailTrust.ts",
            "GuardrailEvent.ts",
            "FlightSummary.ts",
            "TokenTotals.ts",
            "QuarantineEvent.ts",
            "IssueMapPreview.ts",
            "SubIssuePreview.ts",
            "GroupCount.ts",
            "PriorMap.ts",
            "GroupIntro.ts",
            "IssueMapNarrative.ts",
            "IssueMapResult.ts",
            "PortableLockExport.ts",
            "UsageMeter.ts",
            "ProviderUsage.ts",
            "RateWindow.ts",
            "Credits.ts",
            "UsageStatus.ts",
            "UsageCost.ts",
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
