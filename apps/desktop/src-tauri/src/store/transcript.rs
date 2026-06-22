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
/// async reader task that emits `nc:session`. Best-effort: a write failure is logged
/// and swallowed so transcript persistence can never break the live stream. The
/// event is serialized as a single compact JSON line.
///
/// Perf #4: the file I/O (create-dir + open + append) is moved off the reader task
/// via `tokio::task::spawn_blocking`, so a slow disk can't stall the live event
/// stream. The cheap parts (path resolution, JSON serialization) run inline; only
/// the blocking syscalls are offloaded. Ordering within a single task's transcript
/// is preserved because the append opens in `append` mode (each write seeks to EOF)
/// and the events for one session arrive serially on the one reader.
pub fn append_event(store: &TaskStore, task_id: &str, event: &Value) {
    // Defence in depth: a task id is a flat filename component, never a path. Refuse
    // anything that could escape the per-task subdir (mirrors `store::path_for`).
    if !crate::store::is_safe_task_id(task_id) {
        tracing::warn!(target: "nightcore::transcript", task_id, "refusing transcript append for unsafe task id");
        return;
    }
    let path = transcript_path(&store.tasks_dir(), task_id);
    let mut line = match serde_json::to_string(event) {
        Ok(line) => line,
        Err(e) => {
            tracing::warn!(target: "nightcore::transcript", task_id, error = %e, "cannot serialize transcript event");
            return;
        }
    };
    line.push('\n');
    let task_id = task_id.to_string();
    // Offload the blocking filesystem work; if there's no Tokio runtime (unit tests
    // call this synchronously), fall back to a direct write so behavior is identical.
    match tokio::runtime::Handle::try_current() {
        Ok(_) => {
            tokio::task::spawn_blocking(move || write_line(&path, &task_id, &line));
        }
        Err(_) => write_line(&path, &task_id, &line),
    }
}

/// The blocking append: create the per-task dir if needed, then open in append mode
/// and write one line. Logged-and-swallowed on failure (best-effort persistence).
fn write_line(path: &Path, task_id: &str, line: &str) {
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!(target: "nightcore::transcript", task_id, error = %e, "cannot create transcript dir");
            return;
        }
    }
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        Ok(mut file) => {
            if let Err(e) = file.write_all(line.as_bytes()) {
                tracing::warn!(target: "nightcore::transcript", task_id, error = %e, "cannot append transcript event");
            }
        }
        Err(e) => {
            tracing::warn!(target: "nightcore::transcript", task_id, error = %e, "cannot open transcript file")
        }
    }
}

/// Read the persisted events for a task (M4.7 §C), tail-bounded to
/// [`TRANSCRIPT_TAIL`]. Each line is one `NightcoreEvent`; unparsable lines are
/// skipped. Returns an empty vec when the task has no transcript yet (never an
/// error — a task that hasn't run simply has nothing to reseed).
fn read_events(tasks_dir: &Path, task_id: &str) -> Vec<Value> {
    // Defence in depth: reject a task id that isn't a flat filename component before
    // joining it into the transcript path (path-traversal at the command boundary).
    if !crate::store::is_safe_task_id(task_id) {
        return Vec::new();
    }
    let path = transcript_path(tasks_dir, task_id);
    let Some(tail) = read_tail_lines(&path, TRANSCRIPT_TAIL) else {
        return Vec::new();
    };
    tail.iter()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect()
}

/// Read at most the last `max_lines` lines of a file from the END (perf #9), instead
/// of loading the whole transcript and dropping all but the tail. Reads fixed-size
/// chunks backwards until enough newlines are seen (or the file starts), so a
/// thousands-of-lines transcript only touches its recent window. Returns `None` when
/// the file is missing/unreadable (a task that hasn't run has no transcript yet).
fn read_tail_lines(path: &Path, max_lines: usize) -> Option<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return Some(Vec::new());
    }

    const CHUNK: u64 = 64 * 1024;
    let mut buf: Vec<u8> = Vec::new();
    let mut pos = len;
    // Count newlines as we walk backwards; stop once we've seen one more than we need
    // (so the partial line before the first kept newline is excluded), or hit BOF.
    let mut newlines = 0usize;
    while pos > 0 && newlines <= max_lines {
        let read_size = CHUNK.min(pos);
        pos -= read_size;
        file.seek(SeekFrom::Start(pos)).ok()?;
        let mut chunk = vec![0u8; read_size as usize];
        file.read_exact(&mut chunk).ok()?;
        newlines += chunk.iter().filter(|&&b| b == b'\n').count();
        // Prepend this earlier chunk in front of what we've accumulated.
        chunk.extend_from_slice(&buf);
        buf = chunk;
    }

    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    if lines.len() > max_lines {
        let drop = lines.len() - max_lines;
        lines.drain(0..drop);
    }
    Some(lines)
}

// --- Commands ---------------------------------------------------------------

/// Return a task's persisted transcript events (tail-bounded). The web reseeds its
/// `nc:session` stream view from this on mount / when a task is opened, so a reload
/// no longer blanks the transcript (M4.7 §C).
#[tauri::command]
pub fn read_transcript(store: State<'_, TaskStore>, task_id: String) -> Result<Vec<Value>, String> {
    Ok(read_events(&store.tasks_dir(), &task_id))
}

/// Delete a task's transcript directory (best-effort). Called when a task is
/// removed so a deleted task leaves no orphaned transcript behind.
pub fn remove_transcript(app: &tauri::AppHandle, task_id: &str) {
    // Defence in depth: never `remove_dir_all` a path joined from an unsafe id.
    if !crate::store::is_safe_task_id(task_id) {
        tracing::warn!(target: "nightcore::transcript", task_id, "refusing transcript removal for unsafe task id");
        return;
    }
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
        assert_eq!(
            got.last().unwrap()["seq"],
            serde_json::json!(TRANSCRIPT_TAIL + 49)
        );
        assert_eq!(got.first().unwrap()["seq"], serde_json::json!(50));
    }

    #[test]
    fn tail_read_handles_a_multi_chunk_file_and_small_tail() {
        // perf #9: the backward chunked read must reconstruct the correct last-N
        // lines even when the kept tail spans more than one 64KB read chunk, and
        // when the requested tail exceeds the file's line count.
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("t");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("transcript.jsonl");

        // Write lines whose total size comfortably exceeds one 64KB chunk so the
        // tail crosses a chunk boundary (each line ~ a few hundred bytes × 2000).
        let mut content = String::new();
        for i in 0..2000 {
            content.push_str(&format!(
                "{{\"seq\":{i},\"pad\":\"{}\"}}\n",
                "x".repeat(200)
            ));
        }
        std::fs::write(&path, &content).unwrap();

        // Ask for the last 500 lines: must be exactly the final 500, in order.
        let tail = read_tail_lines(&path, 500).expect("tail");
        assert_eq!(tail.len(), 500, "exactly the requested tail count");
        let first: serde_json::Value = serde_json::from_str(&tail[0]).unwrap();
        let last: serde_json::Value = serde_json::from_str(tail.last().unwrap()).unwrap();
        assert_eq!(
            first["seq"],
            serde_json::json!(1500),
            "tail starts at line 2000-500"
        );
        assert_eq!(
            last["seq"],
            serde_json::json!(1999),
            "tail ends at the last line"
        );

        // A tail larger than the file returns every line, none dropped.
        std::fs::write(&path, "a\nb\nc\n").unwrap();
        let all = read_tail_lines(&path, 100).expect("tail");
        assert_eq!(all, vec!["a", "b", "c"]);
    }

    #[test]
    fn unsafe_task_id_is_refused_at_the_transcript_boundary() {
        // Security: a traversal-shaped id must neither write nor read a transcript
        // outside the per-task subdir. append is a no-op; read returns empty.
        let (store, _tmp) = temp_store();
        for bad in ["../escape", "a/b", "a\\b", "..", "with.dot", ""] {
            append_event(&store, bad, &serde_json::json!({"type":"x"}));
            assert!(
                read_events(&store.tasks_dir(), bad).is_empty(),
                "unsafe id {bad:?} reads nothing"
            );
            // The append must not have created any file under the tasks dir.
            let leaked = std::fs::read_dir(store.tasks_dir())
                .map(|rd| rd.flatten().count())
                .unwrap_or(0);
            assert_eq!(leaked, 0, "unsafe id {bad:?} wrote no transcript file");
        }
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
        assert_eq!(
            got.len(),
            2,
            "the junk line is skipped, the valid ones survive"
        );
    }
}
