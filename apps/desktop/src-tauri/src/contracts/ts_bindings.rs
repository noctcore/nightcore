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
    use crate::gauntlet::{GauntletResult, GauntletStep, StepStatus};
    use crate::m2::coordinator::LoopSnapshot;
    use crate::m2::worktree::WorktreeStatus;
    use crate::project::Project;
    use crate::settings::{
        AppInfo, McpServerEntry, McpServerTransport, Settings, SettingsOverride, SettingsPatch,
    };
    use crate::sidecar::{ProviderConfigSnapshotView, SessionInfoView, SessionMessageView};
    use crate::task::{PermissionMode, RunMode, Task, TaskKind, TaskPatch, TaskStatus};

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
        Project,
        Settings,
        SettingsOverride,
        SettingsPatch,
        // The MCP server form types (also reached transitively via Settings).
        McpServerEntry,
        McpServerTransport,
        AppInfo,
        WorktreeStatus,
        GauntletResult,
        GauntletStep,
        StepStatus,
        LoopSnapshot,
        SessionInfoView,
        SessionMessageView,
        // `export_all` writes the snapshot AND its nested section/summary views.
        ProviderConfigSnapshotView,
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
            "Project.ts",
            "Settings.ts",
            "SettingsOverride.ts",
            "SettingsPatch.ts",
            "McpServerEntry.ts",
            "McpServerTransport.ts",
            "AppInfo.ts",
            "WorktreeInfo.ts",
            "GauntletResult.ts",
            "GauntletStep.ts",
            "StepStatus.ts",
            "LoopEnvelope.ts",
            "SessionInfo.ts",
            "SessionMessage.ts",
            "ProviderConfigSnapshot.ts",
            "ProviderConfigSection.ts",
            "McpServerSummary.ts",
            "SkillSummary.ts",
            "SubagentSummary.ts",
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
