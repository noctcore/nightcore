//! Nightcore desktop core.
//!
//! The Rust side is the orchestration brain: it owns the task registry (M1) and
//! eventually the auto-loop, concurrency, and per-task git worktrees. The Claude
//! Agent SDK has no Rust binding, so the actual agent loop runs in a Bun
//! **sidecar** that this core spawns and drives over an NDJSON stdio protocol
//! (see `sidecar.rs`). The webview is a thin client that calls Tauri commands and
//! renders the `nc:task` / `nc:session` streams.
//!
//! M1 scope: a persistent task registry with a Kanban board. Tasks are created,
//! edited, and persisted as JSON under `<workspace>/.nightcore/tasks/`; one task
//! at a time runs through a single long-lived sidecar, streaming its events to
//! the board and transitioning to `done`/`failed` on completion.

mod commands;
mod contracts;
mod engine_api;
mod infra;
mod orchestration;
mod provider;
mod sidecar;
mod store;
mod sync;
mod workflow;
mod worktree;

// Module facade: preserve the historical crate-root paths after the folder
// regroup so call sites elsewhere keep resolving unchanged. Crate-internal
// (`pub(crate)`) — these are not part of the lib's public API (only `run` is), so
// the re-export must not widen doc visibility beyond the original private `mod`s.
pub(crate) use infra::{logging, platform};
pub(crate) use store::{project, settings, task, transcript};
pub(crate) use workflow::{gauntlet, gauntlet_project, kind, merge, plan_approval};

use orchestration::coordinator::Orchestrator;
use project::ProjectStore;
use settings::SettingsStore;
use store::{workspace_root, TaskStore};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First thing, while still single-threaded: a Finder/Dock launch inherits
    // launchd's minimal PATH, so hydrate it from the login shell before we spawn the
    // sidecar (and through it the agent's Bash tool + the gauntlet) — otherwise none
    // of them can find bun/cargo/Homebrew tools. No-op on a terminal/dev launch.
    platform::hydrate_login_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            use tauri::Manager;

            // Stand up logging before anything else so every subsequent line (store
            // load, reconciliation, the auto-loop) lands in the colored console and
            // the rolling file sink. The returned guard must outlive the app, so it
            // is parked in managed state below.
            let log_guard = logging::init(&app.handle().clone());

            // The project registry + settings live in the app config dir (not in
            // any single repo). Resolve it once and load both stores from it.
            let config_dir = app
                .path()
                .app_config_dir()
                .expect("app config dir unavailable");
            let project_store = ProjectStore::load_from(config_dir.clone());

            // Tasks are project-scoped: point the task store at the active
            // project's tasks dir on startup (or an empty scratch dir when no
            // project is active, so the board opens empty on the Projects view).
            let task_store = TaskStore::load();
            let tasks_dir = project_store
                .active_tasks_dir()
                .unwrap_or_else(|| config_dir.join("no-active-project/tasks"));
            task_store.retarget(tasks_dir);

            // Insight analysis runs are project-scoped like tasks: load the active
            // project's `.nightcore/insights/` (or an empty scratch dir when none).
            let insights_dir = project_store
                .active_insights_dir()
                .unwrap_or_else(|| config_dir.join("no-active-project/insights"));
            let insight_store = store::insight::InsightStore::load_from(insights_dir);
            // A run left `running` by a previous process can never complete (the
            // engine that drove it is gone); reap it on boot so the UI doesn't spin.
            insight_store.reap_running();

            // Harness scans are project-scoped like Insight runs: load the active
            // project's `.nightcore/harness/` (or an empty scratch dir when none).
            let harness_dir = project_store
                .active_harness_dir()
                .unwrap_or_else(|| config_dir.join("no-active-project/harness"));
            let harness_store = store::harness::HarnessStore::load_from(harness_dir);
            // Reap scans left `running` by a dead process so the UI doesn't spin.
            harness_store.reap_running();

            // Readiness Scorecard runs are project-scoped like Insight/Harness: load
            // the active project's `.nightcore/scorecards/` (or an empty scratch dir).
            let scorecards_dir = project_store
                .active_scorecards_dir()
                .unwrap_or_else(|| config_dir.join("no-active-project/scorecards"));
            let scorecard_store = store::scorecard::ScorecardStore::load_from(scorecards_dir);
            // Reap runs left `running` by a dead process so the UI doesn't spin.
            scorecard_store.reap_running();

            // The orchestrator (slot manager + circuit breaker + provider +
            // auto-loop) starts at the persisted concurrency. The provider spawns
            // `bun run apps/sidecar/src/index.ts` in the workspace root on first use.
            let settings_store = SettingsStore::load_from(config_dir);
            let max_concurrency = settings_store.get().max_concurrency.max(1) as usize;
            let orchestrator = Orchestrator::new(
                workspace_root().join("apps/sidecar/src/index.ts"),
                workspace_root(),
                max_concurrency,
            );

            app.manage(task_store);
            app.manage(insight_store);
            app.manage(harness_store);
            app.manage(scorecard_store);
            app.manage(project_store);
            app.manage(settings_store);
            // Share the provider handle so the sidecar bridge can reach it as its own
            // managed `Arc<SidecarProvider>` state (instead of through the
            // Orchestrator), and expose the engine's command surface behind the
            // `EngineApi` trait — together these break the orchestration↔sidecar cycle.
            let provider_handle = std::sync::Arc::clone(&orchestrator.provider);
            app.manage(orchestrator);
            app.manage(provider_handle);
            app.manage(std::sync::Arc::new(orchestration::EngineHandle)
                as std::sync::Arc<dyn engine_api::EngineApi>);
            app.manage(log_guard);

            // Startup reconciliation: prune orphaned worktrees from the active
            // project whose tasks no longer exist (best-effort, never blocks).
            orchestration::coordinator::reconcile_worktrees(&app.handle().clone());
            // Then recover crash-stranded tasks: an `InProgress`/`Verifying` task
            // whose run died with the process is re-queued (or re-reviewed) so the
            // auto-loop can pick it up again instead of stranding it forever.
            orchestration::coordinator::reconcile_tasks(&app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::task::list_tasks,
            commands::task::create_task,
            commands::task::convert_subtask,
            commands::task::convert_all_subtasks,
            commands::task::update_task,
            commands::task::delete_task,
            commands::task::add_task_attachments,
            commands::task::remove_task_attachment,
            commands::task::read_task_attachment,
            commands::task::move_task,
            commands::task::blocked_task_ids,
            sidecar::run_task,
            sidecar::cancel_task,
            sidecar::respond_permission,
            sidecar::answer_question,
            sidecar::list_task_sessions,
            sidecar::get_task_session_messages,
            sidecar::resume_session,
            sidecar::rename_session,
            sidecar::tag_session,
            sidecar::get_provider_config,
            sidecar::start_analysis,
            sidecar::cancel_analysis,
            sidecar::list_insight_runs,
            sidecar::get_insight_run,
            sidecar::dismiss_finding,
            sidecar::restore_finding,
            sidecar::convert_finding_to_task,
            sidecar::delete_insight_run,
            sidecar::start_harness_scan,
            sidecar::cancel_harness_scan,
            sidecar::list_harness_runs,
            sidecar::get_harness_run,
            sidecar::delete_harness_run,
            sidecar::dismiss_harness_finding,
            sidecar::restore_harness_finding,
            sidecar::dismiss_harness_artifact,
            sidecar::restore_harness_artifact,
            sidecar::apply_harness_artifact,
            sidecar::start_scorecard,
            sidecar::cancel_scorecard,
            sidecar::list_scorecard_runs,
            sidecar::get_scorecard_run,
            sidecar::delete_scorecard_run,
            sidecar::convert_reading_to_task,
            transcript::read_transcript,
            plan_approval::approve_task,
            plan_approval::reject_task,
            plan_approval::refine_task,
            merge::commit_task,
            merge::merge_task,
            merge::accept_review,
            merge::reject_review,
            merge::rerun_verification,
            gauntlet::run_gauntlet,
            commands::project::list_projects,
            commands::project::active_project,
            commands::project::create_project,
            commands::project::delete_project,
            commands::project::set_active_project,
            commands::project::rename_project,
            commands::project::is_git_repo,
            commands::project::git_init,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::app_info,
            store::context::get_context_pack,
            store::context::set_context_pack,
            store::context::regenerate_context_pack,
            orchestration::coordinator::start_auto_loop,
            orchestration::coordinator::stop_auto_loop,
            orchestration::coordinator::resume_auto_loop,
            orchestration::coordinator::set_max_concurrency_cmd,
            orchestration::coordinator::list_worktrees,
            commands::worktree::list_branches,
            commands::worktree::merge_preview,
            commands::worktree::worktree_diff,
            commands::worktree::discard_worktree,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Nightcore application");
}
