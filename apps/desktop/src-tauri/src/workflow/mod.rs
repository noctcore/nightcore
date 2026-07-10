//! Task-lifecycle command modules: plan approval, merge, the PR arc (create-PR
//! commands + drafting over the shared `claude -p` one-shot core), the
//! verification gauntlets and their built-in hardening checks (anti-gaming
//! sweep, diff budget, strictness ratchet), the commit-path secret gate, and
//! the per-kind run policy. Grouped here so the crate root holds only the
//! module tree; the historical `crate::{gauntlet, kind, merge, plan_approval}`
//! paths are preserved by the facade re-exports in `lib.rs` (the newer modules
//! are addressed as `crate::workflow::*` directly).

pub(crate) mod anti_gaming;
pub(crate) mod commit_msg;
pub(crate) mod contract_budget;
pub(crate) mod diff_budget;
pub(crate) mod gauntlet;
pub(crate) mod gauntlet_project;
pub(crate) mod issue_triage;
pub(crate) mod kind;
pub(crate) mod merge;
pub(crate) mod oneshot;
pub(crate) mod plan_approval;
pub(crate) mod pr;
pub(crate) mod pr_changed_files;
pub(crate) mod pr_comments;
pub(crate) mod pr_fix;
pub(crate) mod pr_list;
pub(crate) mod pr_msg;
pub(crate) mod pr_review_post;
pub(crate) mod pr_status;
pub(crate) mod ratchet;
pub(crate) mod secret_scan;
pub(crate) mod trust;
