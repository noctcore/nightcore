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

/// Append one ALREADY-SERIALIZED streamed event to a task's transcript (M4.7 §C).
/// This is the hot path: the sidecar reader serializes each `nc:session` event
/// exactly once (into a `RawValue` shared with the webview emit) and hands the
/// resulting JSON `line` here, so the event is never re-serialized just to persist
/// it. The `line` is one compact JSON object with NO trailing newline (the newline
/// is appended here). Best-effort: a write failure is logged and swallowed so
/// transcript persistence can never break the live stream.
///
/// Perf #4: the file I/O (create-dir + open + append) is moved off the reader task
/// via `tokio::task::spawn_blocking`, so a slow disk can't stall the live event
/// stream. The cheap parts (path resolution, the owned copy) run inline; only the
/// blocking syscalls are offloaded. Ordering within a single task's transcript is
/// preserved because the append opens in `append` mode (each write seeks to EOF) and
/// the events for one session arrive serially on the one reader.
pub fn append_line(store: &TaskStore, task_id: &str, line: &str) {
    // Defence in depth: a task id is a flat filename component, never a path. Refuse
    // anything that could escape the per-task subdir (mirrors `store::path_for`).
    if !crate::store::is_safe_task_id(task_id) {
        tracing::warn!(target: "nightcore::transcript", task_id, "refusing transcript append for unsafe task id");
        return;
    }
    let path = transcript_path(&store.tasks_dir(), task_id);
    // Own the bytes to move into `spawn_blocking`, appending the record separator in
    // the same allocation (one flat copy — far cheaper than the deep `Value` clone the
    // old wrapper paid per streamed delta).
    let mut owned = String::with_capacity(line.len() + 1);
    owned.push_str(line);
    owned.push('\n');
    let task_id = task_id.to_string();
    match tokio::runtime::Handle::try_current() {
        Ok(_) => {
            tokio::task::spawn_blocking(move || write_line(&path, &task_id, &owned));
        }
        Err(_) => write_line(&path, &task_id, &owned),
    }
}

/// The blocking append: create the per-task dir if needed, then open in append mode
/// and write one line. Logged-and-swallowed on failure (best-effort persistence).
///
/// Security: the transcript persists UNREDACTED tool I/O — including whatever
/// secrets the agent read (a `cat ~/.aws/credentials`, a Read of a repo `.env`).
/// So, on Unix, the per-task dir is created 0700 and the file 0600 at creation
/// (mirroring `settings/helpers.rs::restrict_to_owner`), so another local user or a
/// home-dir backup/sync tool can't read it off this predictable path.
fn write_line(path: &Path, task_id: &str, line: &str) {
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!(target: "nightcore::transcript", task_id, error = %e, "cannot create transcript dir");
            return;
        }
        restrict_dir_to_owner(parent);
    }
    match owner_only_append(path) {
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

/// Open the transcript in create+append mode, applying owner-only (0600) perms AT
/// CREATION on Unix so a secret-bearing line is never written at the default umask.
/// An existing file keeps its perms (already 0600 from the first write); on non-Unix
/// there is no mode bit.
fn owner_only_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

/// Best-effort: restrict the per-task transcript dir to owner-only (0700) on Unix so
/// its contents aren't listable/readable by other local users. A failure is
/// swallowed — the file itself is still created 0600, and this is defence in depth.
#[cfg(unix)]
fn restrict_dir_to_owner(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn restrict_dir_to_owner(_dir: &Path) {}

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

/// A compact, bounded plain-text digest of a task's transcript for commit-message
/// context (M-commit): the assistant's prose (`text` fields) and the names of the
/// tools it used (`toolName`), in order, joined and tail-capped to `max_chars` (the
/// recent window is the most relevant to the final diff). Returns an empty string
/// when the task has no transcript yet — the caller treats that as "no extra
/// context" and leans on the diff alone. Best-effort and lossy by design: it is one
/// of several inputs to the generator, never the source of truth.
pub(crate) fn digest(store: &TaskStore, task_id: &str, max_chars: usize) -> String {
    let events = read_events(&store.tasks_dir(), task_id);
    let mut parts: Vec<String> = Vec::new();
    for ev in &events {
        if let Some(text) = ev.get("text").and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() {
                parts.push(text.to_string());
            }
        } else if let Some(name) = ev.get("toolName").and_then(Value::as_str) {
            parts.push(format!("[{name}]"));
        }
    }
    let joined = parts.join(" ");
    if joined.chars().count() <= max_chars {
        return joined;
    }
    // Keep the LAST `max_chars` characters (char-safe), prefixed with an ellipsis so
    // the reader knows the head was elided.
    let tail: String = joined
        .chars()
        .rev()
        .take(max_chars)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("…{tail}")
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

    /// Serialize a `Value` and append it as one wire line — mirrors exactly what the
    /// reader does (serialize the event, then hand the JSON to `append_line`). A test
    /// convenience so the cases below can express intent with a `Value` literal.
    fn append_event(store: &TaskStore, task_id: &str, event: &Value) {
        match serde_json::to_string(event) {
            Ok(line) => append_line(store, task_id, &line),
            // The reader logs-and-drops an unserializable event; unsafe ids never reach
            // serialization in these tests, so surface any real serialize failure loudly.
            Err(e) => panic!("test event failed to serialize: {e}"),
        }
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
    fn append_line_persists_a_preserialized_wire_line() {
        // The reader hot path serializes each event ONCE and hands the JSON here via
        // `append_line`; it must round-trip identically to `append_event`.
        let (store, _tmp) = temp_store();
        let task = Task::new("t".into(), String::new());
        store.upsert(&task).expect("upsert");

        let event = serde_json::json!({"type":"assistant-text","text":"hi"});
        let line = serde_json::to_string(&event).expect("serialize");
        append_line(&store, &task.id, &line);

        let got = read_events(&store.tasks_dir(), &task.id);
        assert_eq!(
            got.len(),
            1,
            "the pre-serialized line is read back as one event"
        );
        assert_eq!(got[0], event, "round-trips byte-for-byte with append_event");
    }

    #[test]
    fn append_line_refuses_unsafe_task_id() {
        // The safe-id guard is the single write chokepoint: it must reject via
        // `append_line` too, not just `append_event`.
        let (store, _tmp) = temp_store();
        append_line(&store, "../escape", "{\"type\":\"x\"}");
        let leaked = std::fs::read_dir(store.tasks_dir())
            .map(|rd| rd.flatten().count())
            .unwrap_or(0);
        assert_eq!(
            leaked, 0,
            "unsafe id wrote no transcript file via append_line"
        );
    }

    #[test]
    fn read_missing_transcript_is_empty_not_error() {
        let (store, _tmp) = temp_store();
        // A task that never ran has no transcript file → an empty vec, never an err.
        assert!(read_events(&store.tasks_dir(), "ghost").is_empty());
    }

    #[test]
    fn digest_summarizes_text_and_tool_names() {
        let (store, _tmp) = temp_store();
        let task = Task::new("t".into(), String::new());
        store.upsert(&task).expect("upsert");
        append_event(
            &store,
            &task.id,
            &serde_json::json!({"type":"assistant-text","text":"Implemented login"}),
        );
        append_event(
            &store,
            &task.id,
            &serde_json::json!({"type":"tool-use-requested","toolName":"Write"}),
        );
        let d = digest(&store, &task.id, 1_000);
        assert!(
            d.contains("Implemented login"),
            "includes assistant prose: {d}"
        );
        assert!(d.contains("[Write]"), "includes the tool name: {d}");
    }

    #[test]
    fn digest_caps_to_the_tail_with_an_ellipsis() {
        let (store, _tmp) = temp_store();
        let task = Task::new("t".into(), String::new());
        store.upsert(&task).expect("upsert");
        append_event(
            &store,
            &task.id,
            &serde_json::json!({"type":"assistant-text","text":"abcdefghij"}),
        );
        let capped = digest(&store, &task.id, 4);
        assert!(
            capped.starts_with('…'),
            "capped digest is ellipsis-prefixed: {capped:?}"
        );
        // The ellipsis plus exactly `max_chars` trailing characters.
        assert_eq!(
            capped.chars().count(),
            5,
            "ellipsis + max_chars tail: {capped:?}"
        );
        assert!(
            capped.ends_with("ghij"),
            "keeps the most recent characters: {capped:?}"
        );
    }

    #[test]
    fn digest_of_missing_transcript_is_empty() {
        let (store, _tmp) = temp_store();
        assert_eq!(digest(&store, "ghost", 100), "");
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
    #[cfg(unix)]
    fn transcript_file_and_dir_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let (store, _tmp) = temp_store();
        let task = Task::new("t".into(), String::new());
        store.upsert(&task).expect("upsert");

        // A synchronous append (no tokio runtime in the test) writes the file.
        append_line(
            &store,
            &task.id,
            "{\"type\":\"tool-result\",\"text\":\"AKIA-secret\"}",
        );

        let path = transcript_path(&store.tasks_dir(), &task.id);
        let file_mode = std::fs::metadata(&path)
            .expect("file meta")
            .permissions()
            .mode();
        assert_eq!(
            file_mode & 0o777,
            0o600,
            "transcript file must be owner-only, got {:o}",
            file_mode & 0o777
        );
        let dir_mode = std::fs::metadata(path.parent().unwrap())
            .expect("dir meta")
            .permissions()
            .mode();
        assert_eq!(
            dir_mode & 0o777,
            0o700,
            "transcript dir must be owner-only, got {:o}",
            dir_mode & 0o777
        );
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
