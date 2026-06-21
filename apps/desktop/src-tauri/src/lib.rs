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

mod m2;
mod sidecar;
mod store;
mod task;

use sidecar::Sidecar;
use store::TaskStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            // Load the persisted task registry on startup and register the
            // long-lived sidecar handle. Both live in managed state for the app
            // lifetime; commands take them as `State<'_, _>`.
            app.manage(TaskStore::load());
            app.manage(Sidecar::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            task::list_tasks,
            task::create_task,
            task::update_task,
            task::delete_task,
            sidecar::run_task,
            sidecar::cancel_task,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Nightcore application");
}
