//! Nightcore desktop core.
//!
//! The Rust side is the orchestration brain: it owns (eventually) the task
//! registry, the auto-loop, concurrency, and per-task git worktrees. The Claude
//! Agent SDK has no Rust binding, so the actual agent loop runs in a Bun
//! **sidecar** that this core spawns and drives over an NDJSON stdio protocol
//! (see `sidecar.rs`). The webview is a thin client that calls Tauri commands
//! and renders the `nc:event` stream.
//!
//! M0 scope: a single `start_prompt` command that runs one prompt through the
//! sidecar and relays its event stream to the frontend — the end-to-end proof
//! that core ↔ sidecar ↔ SDK ↔ local auth works.

mod sidecar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![sidecar::start_prompt])
        .run(tauri::generate_context!())
        .expect("error while running the Nightcore application");
}
