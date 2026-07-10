//! Trust Report (wayfinder #91) — the per-task governance receipt.
//!
//! An AGGREGATION + RENDERING flow over instrumentation that already exists: the
//! persisted `Task` (gauntlet + reviewer verdict, verbatim — never re-run), the
//! per-task flight-recorder ledger (`store::ledger`), and the transcript
//! (`store::transcript::cost_summary`). ZERO new persistence, zero new writers —
//! the `TrustReport` is minted per request and returned, never stored.
//!
//! A peer of `workflow/gauntlet/`, split by concern so each file stays under the
//! rust-module-shape cap: [`contract`] holds the serde/ts-rs wire types,
//! [`aggregate`] the pure `build_report` composer over the three stores, and
//! [`render`] the ONE canonical markdown renderer (local export + PR attachment +
//! in-drawer preview all render this). The thin `#[tauri::command]` wrappers live
//! in `commands::trust` (a read-only workflow flow; `commands/` stays a thin shell).
//!
//! It composes STORE readers, so it cannot live in `store/` (a persistence leaf);
//! `workflow` is the read-only flow tier that may reach down into `store`.

mod aggregate;
mod contract;
mod render;

#[cfg(test)]
mod tests;

pub(crate) use aggregate::build_report;
pub(crate) use contract::TrustReport;
pub(crate) use render::{render_for_github, render_markdown};

// The nested section shapes (`GauntletTrust`/`GuardrailTrust`/… ) are referenced by
// name ONLY by the ts-rs export aggregator (`bindings/export.rs`, `#[cfg(test)]`);
// `export_all::<TrustReport>()` writes them transitively, so the runtime crate never
// names them. Re-export them for the test-only aggregator so a release build carries
// no unused re-export.
#[cfg(test)]
pub(crate) use contract::{
    FlightSummary, GauntletTrust, GuardrailEvent, GuardrailTrust, QuarantineEvent, TokenTotals,
};
