//! The consolidated git / `gh` subprocess seam.
//!
//! Every git/gh subprocess in the crate routes through this module so the git
//! logic stops being scattered across `worktree/`, `workflow/`, `analysis/`,
//! `sidecar/`, and `commands/`. The security-critical git-env isolation
//! chokepoint stays where it is (`infra/platform.rs::git_command`); the helpers
//! here BUILD ON it — none spawns a raw `Command::new("git")` (a guard test in
//! this module enforces that).
//!
//! Submodules:
//! - [`parse`] — pure porcelain parsers (`--numstat`, `rev-list --left-right`,
//!   `ls-files -z`, `status --porcelain`). No I/O, unit-tested in place.
//! - [`run`] — the git subprocess runners built on `platform::git_command`.

pub(crate) mod parse;
pub(crate) mod run;
