//! The shared MockRuntime test app + scripted-fake-provider helpers for the ring-1
//! E2E suite. Every scenario module boots one [`TestApp`], which builds a headless
//! `tauri::test` app managing the SAME run-engine state graph `lib.rs::run()` wires,
//! then drives the real subsystems through a hand-fed session script.

use std::sync::Arc;

use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::{App, Manager};
use tempfile::TempDir;

use crate::engine_api::{EngineApi, SessionDispatch};
use crate::orchestration::coordinator::Orchestrator;
use crate::orchestration::EngineHandle;
use crate::project::ProjectStore;
use crate::provider::SidecarProvider;
use crate::settings::SettingsStore;
use crate::sidecar::SidecarSessions;
use crate::store::TaskStore;
use crate::task::{build_new_task, CreateInputs, RunMode, Task, TaskKind, TaskStatus};
use crate::workflow::pr_fix::PrFixRegistry;

/// A headless MockRuntime app with the run engine's managed state graph, plus a
/// temp dir every store is rooted in (dropped with the app, so each test is
/// hermetic — no shared on-disk state, no network, no spawned child).
pub(super) struct TestApp {
    app: App<tauri::test::MockRuntime>,
    /// Kept alive for the app's lifetime: the stores mmap files under here.
    _tmp: TempDir,
}

impl TestApp {
    /// Build the harness app. Manages the exact state the run flow reaches —
    /// `TaskStore`, `ProjectStore`, `SettingsStore`, the `Orchestrator` (its
    /// `SlotManager` + `CircuitBreaker` + `SidecarProvider`), the shared
    /// `Arc<SidecarProvider>` handle, the `EngineApi`/`SessionDispatch` seam
    /// adapters, and the `PrFixRegistry` — mirroring `lib.rs::run()`'s `manage`
    /// block so `boot_state` can assert parity. `max_concurrency` sizes the slot
    /// pool for the scenario.
    pub(super) fn boot(max_concurrency: usize) -> Self {
        let tmp = TempDir::new().expect("temp dir");
        let cfg = tmp.path().join("config");
        let tasks = tmp.path().join("tasks");
        // The provider entry/cwd are never spawned in these tests (no child, no
        // network) — they only satisfy the constructor.
        let entry = tmp.path().join("sidecar-entry.ts");
        let cwd = tmp.path().to_path_buf();

        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("mock app builds headlessly");

        app.manage(TaskStore::load_from(tasks));
        app.manage(ProjectStore::load_from(cfg.clone()));
        app.manage(SettingsStore::load_from(cfg));

        let orchestrator = Orchestrator::new(entry, cwd, max_concurrency, "claude");
        // Share the provider handle exactly like `run()`: the reader resolves it as
        // its own `Arc<SidecarProvider>` state, the orchestrator owns the same Arc.
        let provider_handle = Arc::clone(&orchestrator.provider);
        app.manage(orchestrator);
        app.manage(provider_handle);
        app.manage(Arc::new(EngineHandle) as Arc<dyn EngineApi>);
        app.manage(Arc::new(SidecarSessions) as Arc<dyn SessionDispatch>);
        app.manage(PrFixRegistry::default());

        Self { app, _tmp: tmp }
    }

    // --- managed-state accessors (borrow the app) ---------------------------

    /// A clone of the app handle, for `boot_state`'s `state::<T>()` parity probe.
    /// The run engine's `AppHandle` is `Wry`-typed, so this `MockRuntime` handle can
    /// only be used to RESOLVE managed state (`app.state::<T>()`), never to invoke a
    /// production handler — see the module-doc gap note.
    pub(super) fn handle(&self) -> tauri::AppHandle<tauri::test::MockRuntime> {
        self.app.handle().clone()
    }

    pub(super) fn store(&self) -> tauri::State<'_, TaskStore> {
        self.app.state::<TaskStore>()
    }

    pub(super) fn settings(&self) -> tauri::State<'_, SettingsStore> {
        self.app.state::<SettingsStore>()
    }

    pub(super) fn orch(&self) -> tauri::State<'_, Orchestrator> {
        self.app.state::<Orchestrator>()
    }

    pub(super) fn provider(&self) -> tauri::State<'_, Arc<SidecarProvider>> {
        self.app.state::<Arc<SidecarProvider>>()
    }

    // --- scripted flow helpers ---------------------------------------------

    /// Create a fresh backlog task through the real default-stamping builder and
    /// persist it, returning its id. Mirrors the `create_task` command's core
    /// (`build_new_task` + `TaskStore::upsert`) without the `AppHandle`-bound emit.
    pub(super) fn create_backlog_task(&self, kind: TaskKind, run_mode: RunMode) -> String {
        let task = build_new_task(
            &self.settings(),
            None,
            format!("ring-1 task ({kind:?})"),
            String::new(),
            CreateInputs {
                kind: Some(kind),
                run_mode: Some(run_mode),
                ..CreateInputs::default()
            },
        );
        let stored = self.store().upsert(&task).expect("persist new task");
        assert_eq!(
            stored.status,
            TaskStatus::Backlog,
            "new task starts backlog"
        );
        stored.id
    }

    /// Lease a slot + mark the task `InProgress`, the way `submit_run` +
    /// `mark_task_in_progress` do (the `AppHandle`-free half: slot lease via the
    /// real `SlotManager`, the store transition via the real `TaskStore::mutate`).
    /// Returns `false` on a lease race (no free slot) exactly like `submit_run`.
    pub(super) fn lease_and_mark_in_progress(&self, task_id: &str) -> bool {
        if !self.orch().slots.try_lease(task_id) {
            return false;
        }
        self.store()
            .mutate(task_id, |t| {
                t.status = TaskStatus::InProgress;
                t.error = None;
                t.verified = false;
            })
            .expect("mark in progress");
        true
    }

    /// Script a `session-started`: push the pending launch (the test-only FIFO
    /// seam) and correlate the engine-assigned `session_id`, then stamp it on the
    /// task — the exact bookkeeping the reader's `session-started` arm performs.
    /// Returns the bound task id from the real correlation FIFO.
    pub(super) fn script_session_started(&self, task_id: &str, session_id: u64) -> Option<String> {
        self.provider().push_pending_for_test(task_id);
        let bound = self.provider().correlate(session_id);
        if bound.as_deref() == Some(task_id) {
            self.store()
                .mutate(task_id, |t| t.session_id = Some(session_id))
                .expect("stamp session id");
        }
        bound
    }

    /// Script a successful terminal for a NON-verified kind (Research/Decompose-less
    /// path): the reader's `handle_build_completed` `!verify_after` arm — forget the
    /// session, release the slot, and settle the task `Done`. Kept `AppHandle`-free
    /// so it composes the real provider + slot manager + store.
    pub(super) fn script_terminal_done(&self, task_id: &str, session_id: u64, cost: Option<f64>) {
        self.provider().forget(session_id);
        self.store()
            .mutate(task_id, |t| {
                t.status = TaskStatus::Done;
                t.cost_usd = cost;
                t.session_id = Some(session_id);
                t.error = None;
            })
            .expect("settle done");
        self.orch().slots.release(task_id);
        // `finish_run`'s `Outcome::Succeeded` arm resets the breaker window (a clean
        // run clears any accumulated transient failures) — the exact call the
        // production `EngineApi::breaker_record_success` makes on the orchestrator's own
        // breaker.
        self.orch().breaker.record_success();
    }

    /// The store + slot + session teardown every failure terminal shares (the reader's
    /// `session-failed` non-verifying arm settling the task `Failed`, then `finish_run`
    /// forgetting the session and releasing the slot). The breaker feed is the ONLY
    /// thing that differs by `Outcome`, so it stays with each caller below — mirroring
    /// `finish_run`'s per-`Outcome` breaker branch.
    fn settle_failed(&self, task_id: &str, session_id: u64, error: &str) {
        self.provider().forget(session_id);
        self.store()
            .mutate(task_id, |t| {
                t.status = TaskStatus::Failed;
                t.error = Some(error.to_string());
                t.session_id = Some(session_id);
            })
            .expect("settle failed");
        self.orch().slots.release(task_id);
    }

    /// Script a genuine (transient) failure terminal: `finish_run`'s
    /// `Outcome::Failed { fatal: false }` bookkeeping — settle `Failed`, forget the
    /// session, release the slot, and feed the breaker one windowed failure. Returns
    /// whether THIS failure tripped the breaker (mirrors
    /// `EngineApi::breaker_record_failure`).
    pub(super) fn script_terminal_failed(
        &self,
        task_id: &str,
        session_id: u64,
        error: &str,
    ) -> bool {
        self.settle_failed(task_id, session_id, error);
        self.orch().breaker.record_failure()
    }

    /// Script a FATAL-setup failure terminal (auth / disk-full — `is_fatal_setup_failure`):
    /// the same store/slot settling as a transient failure, but `finish_run`'s
    /// `Outcome::Failed { fatal: true }` trips the breaker AT ONCE regardless of the
    /// sliding-window threshold (`EngineApi::breaker_record_fatal`). Returns whether
    /// this failure tripped it.
    pub(super) fn script_terminal_fatal(
        &self,
        task_id: &str,
        session_id: u64,
        error: &str,
    ) -> bool {
        self.settle_failed(task_id, session_id, error);
        self.orch().breaker.record_fatal_failure()
    }

    /// Script an ABORTED terminal (user cancel / circuit-break — `session-failed
    /// { reason: "aborted" }`): the run settles `Failed`, forgets the session, and frees
    /// the slot, but `finish_run`'s `Outcome::Aborted` arm deliberately does NOT feed
    /// the breaker (a cancel is not a broken-setup signal).
    pub(super) fn script_terminal_aborted(&self, task_id: &str, session_id: u64) {
        self.settle_failed(task_id, session_id, "aborted");
    }

    /// Convenience: read a task's current persisted status.
    pub(super) fn status(&self, task_id: &str) -> TaskStatus {
        self.store()
            .get(task_id)
            .map(|t| t.status)
            .expect("task exists")
    }

    /// Convenience: the full persisted task snapshot.
    pub(super) fn task(&self, task_id: &str) -> Task {
        self.store().get(task_id).expect("task exists")
    }
}
