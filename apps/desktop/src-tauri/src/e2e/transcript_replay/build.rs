//! Replay a recorded **build** run transcript through the reader's session
//! correlation + terminal-reconciliation seam.
//!
//! A build run correlates by `sessionId`: the reader's [`handle_event`] binds the
//! first sighting of a session id to the task at the front of the launch FIFO
//! (`SidecarProvider::correlate`), stamps `session_id` / `sdk_session_id` /
//! `actual_model` off `session-ready`, forwards every streamed event to `nc:session`,
//! and on the terminal `session-completed` forgets the session, releases the slot,
//! feeds the breaker, and settles the task. Those halves are all `AppHandle`-free, so
//! we drive them directly here from the checked-in NDJSON transcript.
//!
//! What this does NOT cover: the reader dispatches the completion's heavy tail
//! (`handle_build_completed` — commit + structure-lock gauntlet + gate battery +
//! reviewer dispatch when verification is on) onto an `AppHandle<Wry>`-typed spawned
//! task that `tauri::test`'s `MockRuntime` can't invoke (the documented ring-1 gap —
//! see `super::super`'s module doc). So the terminal here settles the reader's
//! non-verifying build outcome (`Done` + cost), exactly as `e2e::harness`'s
//! `script_terminal_done` models it; the verify→reviewer tail stays covered by the
//! `dogfood:engine` harness.

use std::sync::Arc;

use serde_json::Value;
use tempfile::TempDir;

use crate::orchestration::coordinator::Orchestrator;
use crate::provider::SidecarProvider;
use crate::settings::SettingsStore;
use crate::store::TaskStore;
use crate::task::{build_new_task, CreateInputs, RunMode, Task, TaskKind, TaskStatus};

use super::replay::parse_transcript;

/// A `session`-correlated replay harness: the real `TaskStore` + `SettingsStore` +
/// `Orchestrator` (its `SlotManager`, `CircuitBreaker`, and `SidecarProvider`
/// correlation), all rooted in one temp dir. Feeds transcript events through a
/// faithful mirror of the reader's session arm and records the routing decision per
/// event so the emission sequence can be asserted.
struct BuildReplay {
    _tmp: TempDir,
    store: TaskStore,
    settings: SettingsStore,
    orch: Orchestrator,
    /// One entry per fed event: `"<type>:<outcome>"`, the reader's per-event routing
    /// decision (forward / stamp / terminal / drop).
    emitted: Vec<String>,
}

impl BuildReplay {
    fn boot(max_concurrency: usize) -> Self {
        let tmp = TempDir::new().expect("temp dir");
        let entry = tmp.path().join("sidecar-entry.ts");
        let cwd = tmp.path().to_path_buf();
        Self {
            store: TaskStore::load_from(tmp.path().join("tasks")),
            settings: SettingsStore::load_from(tmp.path().join("config")),
            orch: Orchestrator::new(entry, cwd, max_concurrency, "claude"),
            emitted: Vec::new(),
            _tmp: tmp,
        }
    }

    fn provider(&self) -> &Arc<SidecarProvider> {
        &self.orch.provider
    }

    /// Create + launch a run: persist a fresh backlog task, lease a slot, mark it
    /// `InProgress`, and seed the pending launch — the exact `submit_run` bookkeeping
    /// that happens BEFORE the sidecar emits its first `session-ready` (the point a
    /// recorded transcript begins). Returns the task id.
    fn launch(&self, kind: TaskKind) -> String {
        let task = build_new_task(
            &self.settings,
            None,
            format!("replay build ({kind:?})"),
            String::new(),
            CreateInputs {
                kind: Some(kind),
                run_mode: Some(RunMode::Main),
                ..CreateInputs::default()
            },
        );
        let id = self.store.upsert(&task).expect("persist task").id;
        assert!(self.orch.slots.try_lease(&id), "a free slot admits the run");
        self.store
            .mutate(&id, |t| t.status = TaskStatus::InProgress)
            .expect("mark in progress");
        self.provider().push_pending_for_test(&id);
        id
    }

    /// Feed one transcript event through the reader's session arm. Mirrors
    /// `sidecar::reader::handle_event`'s session path: correlate → (forward) → route.
    fn feed(&mut self, event: &Value) {
        let event_type = event["type"].as_str().unwrap_or("");
        let session_id = event.get("sessionId").and_then(Value::as_u64);

        // Correlation gate (reader.rs): the first sighting of a session id binds it to
        // the FIFO head; a later event reads the binding back. An uncorrelatable event
        // (no pending launch, or a terminal for an already-forgotten session) is
        // DROPPED here — the reader's `let Some(task_id) = … else { return }`.
        let Some(task_id) = session_id.and_then(|sid| self.provider().correlate(sid)) else {
            self.emitted.push(format!("{event_type}:drop-uncorrelated"));
            return;
        };

        match event_type {
            "session-ready" | "session-started" => {
                let sdk_session_id = event
                    .get("sdkSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let actual_model = event
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|m| !m.is_empty())
                    .map(str::to_string);
                self.store
                    .mutate(&task_id, |t| {
                        t.session_id = session_id;
                        if let Some(ref sdk) = sdk_session_id {
                            t.sdk_session_id = Some(sdk.clone());
                        }
                        if let Some(ref m) = actual_model {
                            t.actual_model = Some(m.clone());
                        }
                    })
                    .expect("stamp session fields");
                self.emitted.push(format!("{event_type}:forward+stamp"));
            }
            "session-completed" => {
                // The reader logs the run duration BEFORE the terminal handlers forget
                // the session; assert the timer was live at the terminal.
                let tracked = session_id
                    .and_then(|sid| self.provider().run_duration_ms(sid))
                    .is_some();
                assert!(tracked, "the run timer is live when the terminal lands");
                let cost = event.get("costUsd").and_then(Value::as_f64);
                // Terminal reconciliation shared by every completion (the `AppHandle`-free
                // half of `finish_run` + the non-verifying `handle_build_completed`):
                // forget the session, settle Done + cost, release the slot, clear the
                // breaker window.
                if let Some(sid) = session_id {
                    self.provider().forget(sid);
                }
                self.store
                    .mutate(&task_id, |t| {
                        t.status = TaskStatus::Done;
                        t.cost_usd = cost;
                        t.session_id = session_id;
                        t.error = None;
                    })
                    .expect("settle done");
                self.orch.slots.release(&task_id);
                self.orch.breaker.record_success();
                self.emitted.push(format!("{event_type}:forward+done"));
            }
            // Streamed mid-run events (assistant deltas, tool use/result): the reader
            // forwards them to `nc:session` and persists them to the transcript, but
            // makes no store mutation (`handle_event`'s `_ => {}`).
            _ => self.emitted.push(format!("{event_type}:forward")),
        }
    }

    fn task(&self, id: &str) -> Task {
        self.store.get(id).expect("task exists")
    }
}

#[test]
fn build_transcript_settles_done_and_reconciles_the_run() {
    let mut h = BuildReplay::boot(1);
    let id = h.launch(TaskKind::Build);
    assert_eq!(h.task(&id).status, TaskStatus::InProgress);
    assert_eq!(h.orch.slots.leased_count(), 1, "the launch holds one slot");

    for event in parse_transcript(include_str!("fixtures/build.jsonl")) {
        h.feed(&event);
    }

    // Store state: the terminal settled the task Done with the run's cost, and the
    // session-ready fields (session id, SDK resume id, the model that actually ran)
    // were stamped off the transcript.
    let done = h.task(&id);
    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.cost_usd, Some(0.42), "the run cost is persisted");
    assert_eq!(
        done.session_id,
        Some(7),
        "the correlated session id is stamped"
    );
    assert_eq!(
        done.sdk_session_id.as_deref(),
        Some("c0ffee00-1a2b-4c3d-8e4f-5a6b7c8d9e0f"),
        "the SDK resume id from session-ready is captured"
    );
    assert_eq!(
        done.actual_model.as_deref(),
        Some("claude-opus-4-8"),
        "the actually-resolved model is captured for the badge"
    );
    assert!(done.error.is_none(), "a clean run carries no error");
    assert!(
        !done.verified,
        "a build completion does not itself mark verified"
    );

    // Run bookkeeping: the terminal freed the slot and forgot the session binding +
    // timer (so a stray re-delivery can't act on it).
    assert_eq!(
        h.orch.slots.leased_count(),
        0,
        "the terminal freed the slot"
    );
    assert!(
        h.provider().task_for(7).is_none(),
        "the session binding is forgotten"
    );
    assert!(
        h.provider().run_duration_ms(7).is_none(),
        "the run timer is cleared"
    );

    // Emitted sequence: every correlated event forwarded in wire order, ready stamped,
    // the terminal settling Done.
    assert_eq!(
        h.emitted,
        vec![
            "session-ready:forward+stamp",
            "assistant-delta:forward",
            "tool-use-requested:forward",
            "tool-result:forward",
            "tool-use-requested:forward",
            "tool-result:forward",
            "assistant-delta:forward",
            "session-completed:forward+done",
        ],
    );
}

#[test]
fn a_redelivered_terminal_is_dropped_as_uncorrelated() {
    // Dedup / terminal reconciliation: after the terminal forgets the session, a
    // re-delivered `session-completed` for the SAME id can't correlate (no binding, no
    // pending launch) and is dropped at the reader's correlation gate — it must never
    // re-settle the task, re-free a slot, or re-feed the breaker.
    let mut h = BuildReplay::boot(1);
    let id = h.launch(TaskKind::Build);
    for event in parse_transcript(include_str!("fixtures/build.jsonl")) {
        h.feed(&event);
    }
    assert_eq!(h.orch.slots.leased_count(), 0);

    // Re-feed the terminal line verbatim.
    let terminal: Value = serde_json::json!({
        "type": "session-completed", "sessionId": 7, "result": "done",
        "costUsd": 0.42, "numTurns": 7, "durationMs": 1234,
    });
    h.feed(&terminal);

    assert_eq!(
        h.emitted.last().map(String::as_str),
        Some("session-completed:drop-uncorrelated"),
        "the re-delivered terminal is dropped, not re-applied"
    );
    assert_eq!(
        h.orch.slots.leased_count(),
        0,
        "a dropped duplicate never releases a second (nonexistent) slot"
    );
    assert_eq!(
        h.task(&id).status,
        TaskStatus::Done,
        "the settled state is untouched"
    );
}
