//! Rust→TS contract codegen + its drift guard (the INVERSE of `generated.rs`).
//!
//! The web's IPC layer (`apps/web/src/lib/bridge.ts`) used to hand-mirror the Rust
//! serde structs (`Task`, `Settings`, `Project`, `WorktreeInfo`, `GauntletResult`,
//! the `nc:loop` payload, …) as TypeScript interfaces — so a Rust field rename
//! silently broke the board at runtime. Those interfaces are now GENERATED from the
//! Rust types via `ts-rs`: each `#[derive(TS)] #[ts(export, export_to = "…")]` type
//! writes its `.ts` binding into `apps/web/src/lib/generated/` when `cargo test`
//! runs, and the bridge imports them.
//!
//! Two layers keep the two sides from drifting (mirroring the zod→Rust guard in
//! `mod.rs`):
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

#[cfg(test)]
use ts_rs::TS;

/// Export every Rust→TS boundary binding to `TS_RS_EXPORT_DIR`
/// (`apps/web/src/lib/generated/`). Idempotent: `cargo test` also exports each type
/// via its own ts-rs-generated test; this is the single documented umbrella so the
/// full boundary set is visible in one place. Panics on an export error so a broken
/// codegen fails the test rather than silently skipping a type.
#[cfg(test)]
fn export_all_bindings() {
    use crate::commands::policy::{HarnessPolicyFile, HarnessPolicyPatch, PolicyDiffBudget};
    use crate::gauntlet::{GauntletResult, GauntletStep};
    use crate::orchestration::coordinator::LoopSnapshot;
    use crate::project::Project;
    use crate::settings::{
        AppInfo, BoardAppearance, BoardBackgroundRef, McpServerEntry, McpServerTransport, Settings,
        SettingsOverride, SettingsPatch,
    };
    use crate::sidecar::{ProviderConfigSnapshotView, SessionInfoView, SessionMessageView};
    use crate::store::injection_scan::InjectionFlag;
    use crate::store::insight::{FindingLocation, InsightRun, InsightUsage, StoredFinding};
    use crate::store::scorecard::{ScorecardEvidence, ScorecardRun, StoredReading};
    use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};
    use crate::task::{
        PermissionMode, ProposedSubtask, RunMode, SubtaskStatus, Task, TaskKind, TaskPatch,
        TaskStatus,
    };
    use crate::workflow::pr::{PrDraft, PrSupport};
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
        // Harness policy authoring: the manifest's `policy` block as the editor
        // reads/patches it, plus the injection-scan flag rows it quarantines.
        HarnessPolicyFile,
        HarnessPolicyPatch,
        PolicyDiffBudget,
        InjectionFlag,
        // PR arc (phase 1): the capability probe + the editable draft shape.
        PrSupport,
        PrDraft,
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
            "HarnessPolicyFile.ts",
            "HarnessPolicyPatch.ts",
            "PolicyDiffBudget.ts",
            "InjectionFlag.ts",
            "PrSupport.ts",
            "PrDraft.ts",
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
