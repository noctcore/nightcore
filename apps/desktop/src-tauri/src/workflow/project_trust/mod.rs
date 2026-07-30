//! Project trust dashboard (issue #399) — the repo-scoped half of the trust story.
//!
//! `workflow::trust` answers "what happened on THIS TASK". A lead asks "what has
//! this REPO looked like this month", and until now nothing could answer it. This
//! module aggregates the three durable sources that already exist — the task store
//! (gate verdicts + spend), the per-task flight-recorder ledgers (guardrail tiers),
//! and the per-project governance journal (`store::governance`, the human
//! decisions) — into one summary, plus the shields-compatible badge a repo can
//! publish.
//!
//! COMPUTED ON DEMAND, NEVER STORED. There is no writer here and there must never
//! be one: a cached summary would be a second source of truth free to drift from
//! the append-only journal it summarizes, which is precisely what the journal
//! exists to prevent. The badge export writes a USER-CHOSEN file outside
//! `.nightcore/` (`infra::path_confine::validate_export_dest`), never back into the
//! store.
//!
//! A peer of `workflow/trust/`, split by the same concerns so each file stays under
//! the rust-module-shape cap: [`contract`] holds the serde/ts-rs wire types,
//! [`aggregate`] the pure composer over the three sources, and [`badge`] the
//! deterministic posture projection. The thin `#[tauri::command]` wrappers live in
//! `commands::governance`.

mod aggregate;
mod badge;
mod contract;

#[cfg(test)]
mod tests;

pub(crate) use aggregate::{badge_of, build_summary};
pub(crate) use contract::ProjectTrustSummary;

// The nested section shapes are referenced by name ONLY by the ts-rs export
// aggregator (`bindings/export.rs`, `#[cfg(test)]`); `export_all::<ProjectTrustSummary>()`
// writes them transitively, so the runtime crate never names them.
#[cfg(test)]
pub(crate) use contract::{
    GauntletTotals, GuardrailTotals, JournalSummary, MergeTotals, RuleTally, SpendTotals,
    TrustBadge,
};
