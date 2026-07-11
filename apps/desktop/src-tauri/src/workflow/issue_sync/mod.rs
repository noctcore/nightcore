//! GitHub two-way issue sync — the WRITEBACK engine (#97, spec §3).
//!
//! Sibling of `workflow/issue_triage/` (the intake half). Projects a linked task's
//! Nightcore lifecycle onto its GitHub issue: an `nc:*` status label kept in sync
//! (idempotent, anti-churn) plus a terminal comment at convert/done/failed, all through
//! the hardened `gh` seam (`git/gh.rs`) and — from the command side — the per-root mutation
//! lease. The issue closes NATIVELY on PR merge via `Closes #N` (PR 3), so nothing here
//! ever issues an explicit close.
//!
//! Split by concern, each a flat sibling under this thin manifest (the house module shape):
//! - [`labels`] — the 5-label `nc:*` vocabulary + the three idempotent `gh api` REST
//!   primitives (`ensure`/`add`/`remove`) + the ensure-cache (§3.1 / §3.3).
//! - [`transition`] — the PURE §3.2 table: `desired_label` / `comment_key` / the
//!   [`pending_work`] delta the command uses to early-out with zero `gh` calls.
//! - [`comment`] — the deterministic, structured-only terminal comment builder (§3.4).
//! - [`degrade`] — the writeback orchestrator + the permission-degradation ladder + the
//!   per-project downgrade cache (§3.6 step 6, §3.8).
//!
//! The `sync_issue_status` command that ties these together (settings gate, project guard,
//! lease, stamp, emit) lives in `sidecar/issue_sync.rs`; the web observer that fires it is
//! PR 3.

mod comment;
mod degrade;
mod labels;
mod transition;

pub(crate) use degrade::apply_writeback;
pub(crate) use transition::pending_work;
