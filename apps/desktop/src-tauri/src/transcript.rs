//! Per-task transcript persistence (M4.7 §C).
//!
//! The live session stream (`nc:session`) is otherwise in-memory only — the web
//! folds it into React state that resets on reload/HMR, so the transcript blanks.
//! This module appends each streamed event to a per-task JSONL file under the
//! active project's `.nightcore/tasks/<id>/transcript.jsonl`, alongside the task's
//! `<id>.json`. The web reseeds its stream view from `read_transcript` on mount.
//!
//! Discipline (mirrors the M4.5 logging rules): this is LOCAL persistence, not
//! telemetry. Tool inputs MAY be persisted here (it's the user's own machine and
//! their transcript) — but the on-the-wire events never carry auth tokens, so none
//! are written. The file is bounded on read (a tail) so a long-running task can't
//! blow up the webview; writes are append-only one JSON object per line.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{Manager, State};

use crate::store::TaskStore;

/// Max events returned by [`read_transcript`]. A long run streams thousands of
/// partial-message deltas; the web only needs the recent window to repaint, so we
/// return the TAIL. The full history stays on disk for inspection.
const TRANSCRIPT_TAIL: usize = 5_000;

/// The transcript file for a task: `<tasks_dir>/<id>/transcript.jsonl`. The
/// per-task subdirectory keeps the transcript out of the task-file glob the store
/// loads (`*.json` directly under the tasks dir), so it never deserializes as a
/// task.
fn transcript_path(tasks_dir: &Path, task_id: &str) -> PathBuf {
    tasks_dir.join(task_id).join("transcript.jsonl")
}

/// Append one streamed event to a task's transcript (M4.7 §C). Called on the same
/// path that emits `nc:session`. Best-effort: a write failure is logged and
/// swallowed so transcript persistence can never break the live stream. The event
/// is serialized as a single compact JSON line.
pub fn append_event(store: &TaskStore, task_id: &str, event: &Value) {
    let path = transcript_path(&store.tasks_dir(), task_id);
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!(target: "nightcore::transcript", task_id, error = %e, "cannot create transcript dir");
            return;
        }
    }
    let mut line = match serde_json::to_string(event) {
        Ok(line) => line,
        Err(e) => {
            tracing::warn!(target: "nightcore::transcript", task_id, error = %e, "cannot serialize transcript event");
            return;
        }
    };
    line.push('\n');
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut file) => {
            if let Err(e) = file.write_all(line.as_bytes()) {
                tracing::warn!(target: "nightcore::transcript", task_id, error = %e, "cannot append transcript event");
            }
        }
        Err(e) => tracing::warn!(target: "nightcore::transcript", task_id, error = %e, "cannot open transcript file"),
    }
}

/// Read the persisted events for a task (M4.7 §C), tail-bounded to
/// [`TRANSCRIPT_TAIL`]. Each line is one `NightcoreEvent`; unparsable lines are
/// skipped. Returns an empty vec when the task has no transcript yet (never an
/// error — a task that hasn't run simply has nothing to reseed).
fn read_events(tasks_dir: &Path, task_id: &str) -> Vec<Value> {
    let path = transcript_path(tasks_dir, task_id);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut events: Vec<Value> = raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    if events.len() > TRANSCRIPT_TAIL {
        events.drain(0..events.len() - TRANSCRIPT_TAIL);
    }
    events
}

// --- Commands ---------------------------------------------------------------

/// Return a task's persisted transcript events (tail-bounded). The web reseeds its
/// `nc:session` stream view from this on mount / when a task is opened, so a reload
/// no longer blanks the transcript (M4.7 §C).
#[tauri::command]
pub fn read_transcript(
    store: State<'_, TaskStore>,
    task_id: String,
) -> Result<Vec<Value>, String> {
    Ok(read_events(&store.tasks_dir(), &task_id))
}

/// Delete a task's transcript directory (best-effort). Called when a task is
/// removed so a deleted task leaves no orphaned transcript behind.
pub fn remove_transcript(app: &tauri::AppHandle, task_id: &str) {
    let dir = app.state::<TaskStore>().tasks_dir().join(task_id);
    if dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            tracing::warn!(target: "nightcore::transcript", task_id, error = %e, "cannot remove transcript dir");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::Task;
    use tempfile::TempDir;

    fn temp_store() -> (TaskStore, TempDir) {
        let tmp = TempDir::new().expect("temp dir");
        let store = TaskStore::load_from(tmp.path().join("tasks"));
        (store, tmp)
    }

    #[test]
    fn append_then_read_round_trips() {
        let (store, _tmp) = temp_store();
        let task = Task::new("t".into(), String::new());
        store.upsert(&task).expect("upsert");

        let e1 = serde_json::json!({"type":"session-started","sessionId":1});
        let e2 = serde_json::json!({"type":"assistant-text","text":"hello"});
        append_event(&store, &task.id, &e1);
        append_event(&store, &task.id, &e2);

        let got = read_events(&store.tasks_dir(), &task.id);
        assert_eq!(got.len(), 2, "both appended events are read back");
        assert_eq!(got[0], e1);
        assert_eq!(got[1], e2);
    }

    #[test]
    fn read_missing_transcript_is_empty_not_error() {
        let (store, _tmp) = temp_store();
        // A task that never ran has no transcript file → an empty vec, never an err.
        assert!(read_events(&store.tasks_dir(), "ghost").is_empty());
    }

    #[test]
    fn transcript_lives_in_a_subdir_not_the_task_glob() {
        // The transcript must NOT sit directly under the tasks dir as a `*.json`
        // file, or the store would try to deserialize it as a Task. It lives at
        // `<tasks_dir>/<id>/transcript.jsonl`.
        let (store, _tmp) = temp_store();
        let path = transcript_path(&store.tasks_dir(), "abc");
        assert!(path.ends_with("abc/transcript.jsonl"));
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("jsonl"));
    }

    #[test]
    fn read_tail_bounds_a_long_transcript() {
        let (store, _tmp) = temp_store();
        let task = Task::new("t".into(), String::new());
        store.upsert(&task).expect("upsert");

        // Append more than the tail window; read returns only the most recent ones.
        for i in 0..(TRANSCRIPT_TAIL + 50) {
            append_event(&store, &task.id, &serde_json::json!({"seq": i}));
        }
        let got = read_events(&store.tasks_dir(), &task.id);
        assert_eq!(got.len(), TRANSCRIPT_TAIL, "read is tail-bounded");
        // The last event is the newest; the first 50 were dropped.
        assert_eq!(got.last().unwrap()["seq"], serde_json::json!(TRANSCRIPT_TAIL + 49));
        assert_eq!(got.first().unwrap()["seq"], serde_json::json!(50));
    }

    #[test]
    fn read_skips_unparsable_lines() {
        let (store, _tmp) = temp_store();
        let dir = store.tasks_dir().join("t1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("transcript.jsonl"),
            "{\"type\":\"ok\"}\nnot json\n{\"type\":\"also-ok\"}\n",
        )
        .unwrap();
        let got = read_events(&store.tasks_dir(), "t1");
        assert_eq!(got.len(), 2, "the junk line is skipped, the valid ones survive");
    }
}
