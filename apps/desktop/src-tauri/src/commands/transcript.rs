//! The transcript-read command (M4.7 §C).
//!
//! Thin Tauri wrapper over the store's transcript reader. The persistence itself
//! — the per-task JSONL writer, the tail-bounded reader, and the deletion path —
//! lives in [`crate::store::transcript`], which stays a pure leaf with no
//! `#[tauri::command]` of its own. This module holds the ONE command that reads a
//! task's transcript back to the web, mirroring the `commands/*` split where a
//! command is a thin shell over store logic.

use tauri::{AppHandle, Manager};

use crate::store::transcript::TranscriptPage;
use crate::store::TaskStore;

/// Return ONE page of a task's persisted transcript, newest page first. The web
/// reseeds its `nc:session` stream view from this on mount / when a task is opened,
/// so a reload no longer blanks the transcript (M4.7 §C). A long session's transcript
/// is a multi-MB NDJSON read + per-line parse, so the body runs on the blocking pool —
/// never on the UI thread.
///
/// Paging (#407): `limit` bounds the page (clamped Rust-side to the tail window;
/// omitted ⇒ the whole window, the pre-paging shape) and `before` continues from a
/// previous page's `nextCursor`. The reseed used to hand the webview the entire
/// 5 000-event window in ONE hop — ~1.8 MB of JSON per task open whether or not the
/// surface needed it. The surface now takes a small first page and walks older pages
/// on its own schedule, so no single hop is large.
#[tauri::command]
pub async fn read_transcript(
    app: AppHandle,
    task_id: String,
    limit: Option<usize>,
    before: Option<u64>,
) -> Result<TranscriptPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // `try_state` so an unmanaged store fails the command gracefully instead
        // of panicking on the pool (the `commit_task` recipe).
        let store = app
            .try_state::<TaskStore>()
            .ok_or_else(|| "task store unavailable".to_string())?;
        Ok(crate::store::transcript::read_events_page(
            &store.tasks_dir(),
            &task_id,
            limit,
            before,
        ))
    })
    .await
    .map_err(|e| format!("read transcript failed to run: {e}"))?
}
