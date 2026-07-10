//! The Tauri command layer.
//!
//! Command handlers that legitimately depend on BOTH the persistence layer
//! ([`crate::store`]) and orchestration ([`crate::orchestration`]) live here, so
//! the `store/` modules can stay pure persistence leaves with no up-calls into
//! orchestration. Phase 2 moves the TASK, PROJECT, and SETTINGS command families
//! here.
//!
//! ## Command-home rule (audit #38 — DECIDED: feature-local commands are blessed)
//! `commands/` is NOT the sole home of `#[tauri::command]`s and is not meant to
//! be. The rule:
//!
//!  - A command whose body belongs to ONE feature module lives WITH that feature
//!    (`sidecar/*` scan/harness/insight commands, `workflow/*` merge/PR/plan
//!    commands, `orchestration/coordinator` loop controls, `analysis/` context) —
//!    lifting them here would only add a forwarding layer and detach each command
//!    from the seams and tests that define it.
//!  - `commands/` is reserved for CROSS-LAYER GLUE: handlers that must touch both
//!    persistence and orchestration (project switch, task CRUD + worktree
//!    cleanup) or that would otherwise force an up-call from a `store/` leaf
//!    (`transcript`, `worktree` queries, the `policy` manifest shells).
//!  - Wherever a command lives, `lib.rs`'s `generate_handler!` lists it in its
//!    FEATURE group (the grouping comments there), and a synchronous command
//!    body must stay allowlisted in `arch_guards` (the main-thread ratchet).

pub mod fs;
pub mod onboarding;
pub mod policy;
pub mod project;
pub mod settings;
pub mod task;
pub mod terminal;
pub mod transcript;
pub mod trust;
pub mod worktree;
