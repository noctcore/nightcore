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

mod contracts;
mod infra;
mod m2;
mod sidecar;
mod store;
mod workflow;

// Module facade: preserve the historical crate-root paths after the folder
// regroup so call sites elsewhere keep resolving unchanged. Crate-internal
// (`pub(crate)`) — these are not part of the lib's public API (only `run` is), so
// the re-export must not widen doc visibility beyond the original private `mod`s.
pub(crate) use infra::{logging, platform};
pub(crate) use store::{project, settings, task, transcript};
pub(crate) use workflow::{gauntlet, kind, merge, plan_approval};

use m2::coordinator::Orchestrator;
use project::ProjectStore;
use settings::SettingsStore;
use store::{workspace_root, TaskStore};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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

            // The M2 orchestrator (slot manager + circuit breaker + provider +
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
            app.manage(project_store);
            app.manage(settings_store);
            app.manage(orchestrator);
            app.manage(log_guard);

            // Startup reconciliation: prune orphaned worktrees from the active
            // project whose tasks no longer exist (best-effort, never blocks).
            m2::coordinator::reconcile_worktrees(&app.handle().clone());
            // Then recover crash-stranded tasks: an `InProgress`/`Verifying` task
            // whose run died with the process is re-queued (or re-reviewed) so the
            // auto-loop can pick it up again instead of stranding it forever.
            m2::coordinator::reconcile_tasks(&app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            task::list_tasks,
            task::create_task,
            task::update_task,
            task::delete_task,
            task::move_task,
            task::blocked_task_ids,
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
            project::list_projects,
            project::active_project,
            project::create_project,
            project::delete_project,
            project::set_active_project,
            project::rename_project,
            project::is_git_repo,
            project::git_init,
            settings::get_settings,
            settings::update_settings,
            settings::app_info,
            m2::coordinator::start_auto_loop,
            m2::coordinator::stop_auto_loop,
            m2::coordinator::resume_auto_loop,
            m2::coordinator::set_max_concurrency_cmd,
            m2::coordinator::list_worktrees,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Nightcore application");
}
