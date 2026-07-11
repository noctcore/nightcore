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

mod analysis;
// Crate-wide architecture guard tests (audit #38): layer-boundary scans + the
// sync-command allowlist ratchet. Test-only; compiled out of every real build.
#[cfg(test)]
mod arch_guards;
mod bindings;
mod commands;
mod contracts;
mod engine_api;
mod git;
mod infra;
mod orchestration;
mod provider;
mod sidecar;
mod store;
mod sync;
// The integrated USER terminal (PTY session registry). A peer of `provider/` /
// `worktree/`; a USER-ONLY seam with no agent/sidecar path into it (see
// `terminal/mod.rs`).
mod terminal;
// The provider usage meter (issue #121): a top-level system-seam module (Keychain +
// HTTP + `~/.claude`/`~/.codex` reads) that polls each provider's usage endpoint. A
// USER-ONLY read-only seam — no agent/sidecar path reaches it (see `usage/mod.rs`).
mod usage;
mod workflow;
mod worktree;

// E2E ladder ring 1 (issue #150): the `tauri::test` MockRuntime integration suite
// over the real run engine (stores + slot manager + provider correlation + breaker),
// driven by a scripted fake provider. Test-only; never compiled into the app.
#[cfg(test)]
mod e2e;

// E2E ladder ring 1 (issue #150), deliverable (b): the `#[ignore]`-gated real-`gh`
// scratch-repo harness (`bun run dogfood:gh`). Never runs in the default battery —
// it needs a scratch GitHub repo + a PAT and mutates real remote state.
#[cfg(test)]
mod e2e_gh;

// Module facade: preserve the historical crate-root paths after the folder
// regroup so call sites elsewhere keep resolving unchanged. Crate-internal
// (`pub(crate)`) — these are not part of the lib's public API (only `run` is), so
// the re-export must not widen doc visibility beyond the original private `mod`s.
pub(crate) use infra::{logging, platform, proc};
pub(crate) use store::{project, settings, task, transcript};
pub(crate) use workflow::{gauntlet, gauntlet_project, kind, merge, plan_approval};

use orchestration::coordinator::Orchestrator;
use project::ProjectStore;
use settings::SettingsStore;
use store::{workspace_root, TaskStore};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // FIRST of all, before ANY Tauri/window/state setup: if this process was
    // re-invoked as the detached PTY daemon (`--terminal-daemon`, cockpit spec PR 6),
    // run the daemon server and never return (it owns the survived shells and speaks
    // only its owner-only local socket). A normal launch returns immediately.
    terminal::daemon::maybe_run_daemon();

    // First thing, while still single-threaded: a Finder/Dock launch inherits
    // launchd's minimal PATH, so hydrate it from the login shell before we spawn the
    // sidecar (and through it the agent's Bash tool + the gauntlet) — otherwise none
    // of them can find bun/cargo/Homebrew tools. No-op on a terminal/dev launch.
    platform::hydrate_login_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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

            // Every run-based scan store (Insight / Harness / Scorecard) is
            // project-scoped like tasks. Boot each from the ONE `scan_kinds!` registry:
            // resolve the active project's `.nightcore/<slug>/` (or an empty scratch dir
            // when none), load it, reap any run left `running` by a dead process (that
            // work can never complete, so reaping stops the UI spinning forever), and
            // hand it to managed state. Adding a scan kind is one row in the registry —
            // no parallel edit here.
            macro_rules! boot_scan_store {
                ($Run:ty, $slug:literal) => {{
                    let dir = project_store
                        .active_scan_dir($slug)
                        .unwrap_or_else(|| config_dir.join("no-active-project").join($slug));
                    let scan_store = store::run_store::RunStore::<$Run>::load_from(dir);
                    scan_store.reap_running();
                    app.manage(scan_store);
                }};
            }
            store::run_store::scan_kinds!(boot_scan_store);

            // The USER terminal backend (PTY sessions) — global (AutoMaker-style
            // tabs), with scrollback persisted under the active project's
            // `.nightcore/terminals/` (retargeted on project switch, like the task
            // + scan stores). USER-ONLY managed state: driven solely by the command
            // layer, never by any agent/sidecar path. Best-effort boot prune drops
            // scrollback for since-discarded worktrees + files past the 30-day age.
            // The backend itself is managed just below, once settings are loaded (it
            // needs the `terminal_daemon_enabled` opt-in, PR 6).
            let terminals_dir = project_store
                .active()
                .map(|p| std::path::Path::new(&p.path).join(".nightcore/terminals"))
                .unwrap_or_else(|| config_dir.join("no-active-project/terminals"));
            terminal::persist::prune(&terminals_dir);

            // The provider usage-meter registry (issue #121): the last-good snapshot +
            // 429 cooldowns + popover cost cache + poll-loop primitives. In-memory only
            // (a restart starts cold; the first poll refills it — spec §3.2). The poll
            // loop is armed at the end of setup only if the opt-in flag is already on.
            app.manage(usage::UsageRegistry::new());

            // The orchestrator (slot manager + circuit breaker + provider +
            // auto-loop) starts at the persisted concurrency. The provider spawns
            // `bun run apps/sidecar/src/index.ts` in the workspace root on first use.
            let settings_store = SettingsStore::load_from(config_dir);
            let (max_concurrency, provider_id) = settings_store
                .with_settings(|s| (s.max_concurrency.max(1) as usize, s.provider.clone()));
            // Whether to arm the usage poll loop at startup (issue #121, spec §3.3):
            // only when the meter is already opted-in. A disabled meter arms lazily
            // via `enable_usage_meter`, so a user who never opts in spawns no loop.
            let usage_meter_enabled = settings_store.with_settings(|s| s.usage_meter_enabled);
            // The USER terminal backend (see the persist-dir prune above). Reads the
            // experimental detached-daemon opt-in (PR 6, decision 7) once at boot: a
            // running app keeps whatever backend it booted with. Inert (in-process,
            // read-only restore) unless the flag is on AND the platform supports it.
            let terminal_daemon_enabled =
                settings_store.with_settings(|s| s.terminal_daemon_enabled);
            app.manage(terminal::TerminalBackend::new(
                terminals_dir,
                terminal_daemon_enabled,
            ));
            let orchestrator = Orchestrator::new(
                workspace_root().join("apps/sidecar/src/index.ts"),
                workspace_root(),
                max_concurrency,
                &provider_id,
            );

            // The scan stores were already handed to managed state by `boot_scan_store`
            // above; task/project/settings are managed here.
            app.manage(task_store);
            app.manage(project_store);
            app.manage(settings_store);
            // Share the provider handle so the sidecar bridge can reach it as its own
            // managed `Arc<SidecarProvider>` state (instead of through the
            // Orchestrator), and expose the engine's command surface behind the
            // `EngineApi` trait — together these break the orchestration↔sidecar cycle.
            let provider_handle = std::sync::Arc::clone(&orchestrator.provider);
            app.manage(orchestrator);
            app.manage(provider_handle);
            // The pr-fix registry (workflow::pr_fix): in-memory v1 — a restart
            // forgets the entries but never the work (the auto-commit survives
            // on the PR branch in its checkout).
            app.manage(workflow::pr_fix::PrFixRegistry::default());
            // The per-provider model catalog cache (issue #80): DERIVED, in-memory —
            // never persisted. A restart starts cold and `list_models` re-fetches; the
            // `(provider, auth-state)` key self-invalidates across provider/auth changes.
            app.manage(store::model_cache::ModelCache::default());
            app.manage(std::sync::Arc::new(orchestration::EngineHandle)
                as std::sync::Arc<dyn engine_api::EngineApi>);
            // The mirror seam for the other direction (issue #33): workflow's
            // session-dispatching commands reach the sidecar bridge through
            // `SessionDispatch`, never as `crate::sidecar::*`.
            app.manage(std::sync::Arc::new(sidecar::SidecarSessions)
                as std::sync::Arc<dyn engine_api::SessionDispatch>);
            app.manage(log_guard);

            // Startup reconciliation: prune orphaned worktrees from the active
            // project whose tasks no longer exist (best-effort, never blocks).
            orchestration::coordinator::reconcile_worktrees(&app.handle().clone());
            // …then clear ghost worktree POINTERS (a task with a stale `branch`
            // chip but no worktree dir left on disk) so a merged/discarded/removed
            // worktree can't strand a dead tab on the board across a restart.
            // Pointer-clear only (no merged-worktree pruning at boot — that stays
            // an explicit user action via `refresh_worktrees`).
            orchestration::coordinator::reconcile_stale_worktree_state(
                &app.handle().clone(),
                false,
            );
            // Then recover crash-stranded tasks: an `InProgress`/`Verifying` task
            // whose run died with the process is re-queued (or re-reviewed) so the
            // auto-loop can pick it up again instead of stranding it forever.
            orchestration::coordinator::reconcile_tasks(&app.handle().clone());

            // Arm the usage poll loop iff the meter is already opted-in (issue #121).
            // The loop reads OAuth credentials + polls each provider on a 10-min
            // cadence; a disabled meter's loop is armed lazily by `enable_usage_meter`.
            if usage_meter_enabled {
                usage::arm(&app.handle().clone());
            }
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
            sidecar::list_models,
            sidecar::get_capabilities,
            // The run-based scan commands (Insight / Harness / Scorecard). The store
            // boot + retarget wiring is driven off the single `scan_kinds!` registry;
            // these command paths must still be listed explicitly because Tauri's
            // `generate_handler!` is a proc-macro that won't expand a nested macro in
            // its input. The lifecycle four per feature (list/get/delete/cancel) are
            // stamped by `scan_lifecycle_commands!`; the rest are hand-written.
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
            sidecar::convert_harness_finding_to_task,
            sidecar::dismiss_harness_proposal,
            sidecar::restore_harness_proposal,
            sidecar::convert_harness_proposal,
            sidecar::dismiss_harness_artifact,
            sidecar::restore_harness_artifact,
            sidecar::apply_harness_artifact,
            sidecar::apply_harness_proposal,
            sidecar::arm_harness_gauntlet_check,
            sidecar::start_scorecard,
            sidecar::cancel_scorecard,
            sidecar::list_scorecard_runs,
            sidecar::get_scorecard_run,
            sidecar::delete_scorecard_run,
            sidecar::convert_reading_to_task,
            sidecar::start_pr_review,
            sidecar::cancel_pr_review,
            sidecar::list_pr_review_runs,
            sidecar::get_pr_review_run,
            sidecar::dismiss_review_finding,
            sidecar::restore_review_finding,
            sidecar::convert_review_finding_to_task,
            sidecar::delete_pr_review_run,
            // Issue Triage (GitHub issue intake + validation). Read seams, the
            // read-only validation start/cancel, the store lifecycle, and the two
            // human-gated actions (post comment / convert to task).
            sidecar::list_project_issues,
            sidecar::fetch_project_issue_detail,
            sidecar::start_issue_validation,
            sidecar::cancel_issue_validation,
            sidecar::list_issue_validations,
            sidecar::get_issue_validation,
            sidecar::delete_issue_validation,
            sidecar::mark_issue_validation_viewed,
            sidecar::preview_issue_comment,
            sidecar::post_issue_validation_comment,
            sidecar::convert_issue_validation_to_task,
            // GitHub two-way sync (#97): project a task's lifecycle onto its linked issue
            // (labels + terminal comments). Async + spawn_blocking (it shells to `gh`).
            sidecar::sync_issue_status,
            // GitHub two-way sync (#97 PR 4): the projection-IN half — the focus-poll that
            // detects an upstream close/reopen (read-only), and the "closed upstream" chip's
            // open action. Both async + spawn_blocking (they shell to `gh`).
            sidecar::poll_issue_states,
            sidecar::open_issue_in_browser,
            // Issue-map export (wayfinder #112): the human-gated full preview + the
            // GitHub write. Both async + spawn_blocking (they shell to `gh`).
            sidecar::preview_issue_map,
            sidecar::export_issue_map,
            workflow::pr_review_post::post_review_to_github,
            workflow::pr_list::list_open_prs,
            workflow::pr_changed_files::pr_changed_files,
            commands::transcript::read_transcript,
            commands::trust::trust_report,
            commands::trust::trust_report_markdown,
            commands::trust::write_trust_report,
            commands::trust::attach_trust_report_to_pr,
            plan_approval::approve_task,
            plan_approval::reject_task,
            plan_approval::refine_task,
            merge::commit_task,
            merge::merge_task,
            merge::accept_review,
            merge::reject_review,
            merge::rerun_verification,
            workflow::pr::pr_support,
            workflow::pr::draft_pr_message,
            workflow::pr::create_pr_task,
            workflow::pr::open_external,
            workflow::pr::viewer_login,
            workflow::pr_status::pr_status,
            workflow::pr_status::pr_status_by_number,
            workflow::pr_status::push_pr_updates,
            workflow::pr_status::finalize_merged_pr,
            workflow::pr_status::pull_base_ff,
            workflow::pr_comments::list_pr_comments,
            workflow::pr_comments::address_pr_comments,
            workflow::pr_comments::triage_pr_comments,
            workflow::pr_fix::address_review_findings,
            workflow::pr_fix::fix_pr_ci,
            workflow::pr_fix::resolve_pr_conflicts,
            workflow::pr_fix::push_pr_fix,
            workflow::pr_fix::list_pr_fixes,
            workflow::pr_fix::cancel_pr_fix,
            workflow::pr_fix::dismiss_pr_fix,
            gauntlet::run_gauntlet,
            workflow::ratchet::snapshot_ratchet_baseline,
            analysis::injection_scan::scan_injection_surface,
            commands::policy::get_harness_policy_file,
            commands::policy::update_harness_policy_file,
            commands::project::list_projects,
            commands::project::active_project,
            commands::project::create_project,
            commands::project::delete_project,
            commands::project::set_active_project,
            commands::project::rename_project,
            commands::project::update_project,
            commands::project::set_project_icon,
            commands::project::save_project_icon,
            commands::project::clear_project_icon,
            commands::project::read_project_icon,
            commands::project::is_git_repo,
            commands::project::git_init,
            commands::onboarding::check_onboarding_prerequisites,
            commands::settings::get_settings,
            commands::settings::update_settings,
            commands::settings::app_info,
            commands::settings::set_board_background,
            commands::settings::clear_board_background,
            commands::settings::read_board_background,
            analysis::context::get_context_pack,
            analysis::context::set_context_pack,
            analysis::context::regenerate_context_pack,
            orchestration::coordinator::start_auto_loop,
            orchestration::coordinator::stop_auto_loop,
            orchestration::coordinator::resume_auto_loop,
            orchestration::coordinator::set_max_concurrency_cmd,
            orchestration::coordinator::list_worktrees,
            orchestration::coordinator::refresh_worktrees,
            commands::worktree::list_branches,
            commands::worktree::merge_preview,
            commands::worktree::worktree_diff,
            commands::worktree::discard_worktree,
            commands::worktree::reveal_worktree,
            commands::worktree::open_in_editor,
            commands::worktree::terminal_create_worktree,
            commands::worktree::list_terminal_worktrees,
            commands::worktree::discard_terminal_worktree,
            commands::settings::list_editors,
            // The integrated USER terminal (PTY). All async (a sync command would
            // freeze the WKWebView); output streams over a per-session binary
            // Channel, not events. USER-ONLY — never wired to an agent session.
            commands::terminal::terminal_spawn,
            commands::terminal::terminal_attach,
            commands::terminal::terminal_daemon_status,
            commands::terminal::terminal_write,
            commands::terminal::terminal_set_title,
            commands::terminal::terminal_suggest_title,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_kill,
            commands::terminal::terminal_list,
            commands::terminal::terminal_sessions_in_dir,
            commands::terminal::terminal_list_persisted,
            commands::terminal::terminal_read_persisted,
            commands::terminal::terminal_delete_persisted,
            // Read-only filesystem browsing for the terminal folder picker (open a
            // shell in ANY directory). Async; never reads file contents or writes.
            commands::fs::list_directory,
            commands::fs::directory_exists,
            // The provider usage meter (issue #121). All async (a sync command would
            // freeze the WKWebView); the meter is a USER-ONLY read-only seam driven
            // solely from the webview, never wired to an agent session.
            commands::usage::enable_usage_meter,
            commands::usage::disable_usage_meter,
            commands::usage::get_usage,
            commands::usage::refresh_usage,
            commands::usage::get_usage_cost,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Nightcore application");
}
