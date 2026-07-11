//! Managed-state parity smoke: a headless MockRuntime app must be able to manage
//! and resolve every `State<T>` the real run flow reaches. The run engine resolves
//! its collaborators lazily via `app.state::<T>()` — a type referenced by a handler
//! but never `manage`d panics at first touch in the real app. Building the same
//! graph headlessly and resolving each one is the cheapest guard against that
//! startup-crash class, and proves the whole run-engine state set is constructible
//! offline (no display, no child, no network).

use std::sync::Arc;

use tauri::Manager;

use crate::engine_api::{EngineApi, SessionDispatch};
use crate::orchestration::coordinator::Orchestrator;
use crate::project::ProjectStore;
use crate::provider::SidecarProvider;
use crate::settings::SettingsStore;
use crate::store::TaskStore;
use crate::workflow::pr_fix::PrFixRegistry;

use super::harness::TestApp;

#[test]
fn mock_app_resolves_every_run_flow_state() {
    let h = TestApp::boot(2);
    let app = h.handle();

    // The reader (`sidecar::reader::handle_event`) resolves these on every event.
    let _ = app.state::<TaskStore>();
    let _ = app.state::<Arc<SidecarProvider>>();
    let _ = app.state::<Arc<dyn EngineApi>>();
    let _ = app.state::<PrFixRegistry>();

    // The launch sequence (`coordinator::submit_run` + `build_guardrails`) resolves
    // these.
    let _ = app.state::<Orchestrator>();
    let _ = app.state::<ProjectStore>();
    let _ = app.state::<SettingsStore>();

    // The verification/workflow dispatch seam resolves this.
    let _ = app.state::<Arc<dyn SessionDispatch>>();
}

#[test]
fn engine_seams_are_the_shared_managed_singletons() {
    // The provider handle managed for the reader is the SAME Arc the orchestrator
    // owns (that identity is what lets a terminal event released via the reader free
    // the slot the orchestrator leased). Assert the shared-Arc wiring `run()` relies
    // on holds in the harness too.
    let h = TestApp::boot(1);
    let via_handle = h.provider();
    let via_orch = &h.orch().provider;
    assert!(
        Arc::ptr_eq(&via_handle, via_orch),
        "the reader's Arc<SidecarProvider> must be the orchestrator's own provider"
    );
}
