//! Test-integrity anti-gaming sweep (production-harness catalog #2): a zero-cost,
//! ALWAYS-ON detector that scans a worktree build's committed diff for the classic
//! ways an agent games a green build instead of earning it — focusing/skipping
//! tests, sprinkling suppressions, tampering with the gate config under
//! `.nightcore/`, or gutting assertions out of existing tests. Built-in for
//! worktree Build tasks: unlike the manifest-driven structure-lock checks, no
//! `.nightcore/harness.json` entry arms it, because the thing it guards is the
//! gate machinery itself.
//!
//! On findings it appends ONE Failed [`crate::store::types::StructureLockCheck`]
//! (name/kind `anti-gaming`) whose `output` lists the exact evidence, so a
//! failure rides the SAME bounded auto-fix / park machinery as every other
//! structure-lock failure — `fix_instruction` hands the agent the list of edits
//! to undo. Zero findings append NOTHING (a silent pass), mirroring how absent
//! config appends no checks.
//!
//! Safety posture (a gate must not fail on its own plumbing):
//!   - the detectors are PURE functions over the diff text, unit-tested without git;
//!   - the git plumbing (base → merge-base → diff) is infrastructure — when any of
//!     it fails (unresolvable base, detached fallback that doesn't exist, git
//!     error) we WARN and skip the whole sweep, never failing the gate;
//!   - `@ts-expect-error` is deliberately NOT flagged: it is the sanctioned,
//!     self-expiring suppression form — flagging it would push agents back to
//!     `@ts-ignore`.
//!
//! Split by responsibility (as the analysis finding suggested): [`detect`] holds
//! the pure diff detectors + the `Finding` type, [`ledger`] the Bash-history
//! `--no-verify` detector, [`report`] the evidence renderer, and [`sweep`] the
//! `append_anti_gaming_check` entry point + its git plumbing. The facade
//! preserves the historical `crate::workflow::anti_gaming::append_anti_gaming_check`
//! path (its only external caller, `sidecar::verification`).

mod detect;
mod ledger;
mod report;
mod sweep;

#[cfg(test)]
mod tests;

pub(crate) use sweep::*;
