//! Task-lifecycle command modules: plan approval, merge, the verification
//! gauntlet, the commit-path secret gate, and the per-kind run policy. Grouped
//! here so the crate root holds only the module tree; the historical
//! `crate::{gauntlet, kind, merge, plan_approval}` paths are preserved by the
//! facade re-exports in `lib.rs`.

pub(crate) mod commit_msg;
pub(crate) mod gauntlet;
pub(crate) mod gauntlet_project;
pub(crate) mod kind;
pub(crate) mod merge;
pub(crate) mod plan_approval;
pub(crate) mod secret_scan;
