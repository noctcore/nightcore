//! The consolidated git / `gh` subprocess seam.
//!
//! Every git/gh subprocess in the crate routes through this module so the git
//! logic stops being scattered across `worktree/`, `workflow/`, `analysis/`,
//! `sidecar/`, and `commands/`. The security-critical git-env isolation
//! chokepoint stays where it is (`infra/platform.rs::git_command`); the helpers
//! here BUILD ON it — none spawns a raw `git` process via `std::process::Command`
//! (a guard test in [`testutil`] enforces that, allowing only the shared test
//! fixture runner).
//!
//! Submodules:
//! - [`parse`] — pure porcelain parsers (`--numstat`, `rev-list --left-right`,
//!   `ls-files -z`, `status --porcelain`). No I/O, unit-tested in place.
//! - [`run`] — the git subprocess runners built on `platform::git_command`.
//! - [`gh`] — the `gh` (GitHub CLI) seam + the checked / JSON orchestration wrappers.
//! - [`query`] — small reusable git READS (tracked-file listing, changed files).

pub(crate) mod gh;
pub(crate) mod parse;
pub(crate) mod query;
pub(crate) mod refname;
pub(crate) mod run;
#[cfg(test)]
pub(crate) mod testutil;

// The historical `crate::worktree::validate_ref` call-site shape is preserved as
// `crate::git::validate_ref` by re-exporting the ref validator at the module root
// (issue #17 phase A.3 moved its home from `worktree::path` to `git::refname`).
pub(crate) use refname::validate_ref;
