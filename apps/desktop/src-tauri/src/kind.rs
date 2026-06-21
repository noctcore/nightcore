//! Per-kind ORCHESTRATION policy (M4 §A, Rust half).
//!
//! `TaskKind` is the contract both tiers share, but each tier owns one half of a
//! kind's policy. The engine (`packages/engine/src/kind-presets.ts`) owns the
//! AGENT DEFINITION — system prompt, toolset, default permission mode. This module
//! owns the ORCHESTRATION side: whether a kind gets its own worktree, whether it
//! is verified after a build completes, and whether it writes code. Neither tier
//! reaches into the other's half.

use crate::task::TaskKind;

/// The orchestration policy for a task kind. Pure data derived from the kind, so
/// it is trivially unit-testable and has no dependency on the live orchestrator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KindPolicy {
    /// Whether a run of this kind gets its own isolated worktree. `build` does;
    /// `review` runs in the build's *existing* worktree (so it diffs the work);
    /// the reserved kinds allocate nothing.
    pub allocate_worktree: bool,
    /// Whether a completed `InProgress` run of this kind enters the verification
    /// gate (`Verifying` + reviewer dispatch) instead of going straight to `Done`.
    pub verify_after: bool,
    /// Whether this kind's agent is expected to modify the worktree. Informational
    /// for the orchestrator (the engine enforces the actual tool restriction).
    pub writes_code: bool,
}

/// Resolve a task kind to its orchestration policy.
pub fn policy(kind: TaskKind) -> KindPolicy {
    match kind {
        TaskKind::Build => KindPolicy {
            allocate_worktree: true,
            verify_after: true,
            writes_code: true,
        },
        TaskKind::Review => KindPolicy {
            allocate_worktree: false,
            verify_after: false,
            writes_code: false,
        },
        // Reserved: defined, not yet produced. No worktree, no verification, no
        // writes — they carry no orchestration weight this milestone.
        TaskKind::Research | TaskKind::Decompose => KindPolicy {
            allocate_worktree: false,
            verify_after: false,
            writes_code: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_allocates_a_worktree_and_is_verified() {
        let p = policy(TaskKind::Build);
        assert!(p.allocate_worktree, "build runs in its own worktree");
        assert!(p.verify_after, "a build is verified before Done");
        assert!(p.writes_code, "a build writes code");
    }

    #[test]
    fn review_runs_in_the_build_worktree_read_only() {
        let p = policy(TaskKind::Review);
        assert!(!p.allocate_worktree, "review reuses the build's worktree");
        assert!(!p.verify_after, "a review is not itself verified");
        assert!(!p.writes_code, "a review is read-only");
    }

    #[test]
    fn reserved_kinds_carry_no_orchestration() {
        for kind in [TaskKind::Research, TaskKind::Decompose] {
            let p = policy(kind);
            assert!(!p.allocate_worktree && !p.verify_after && !p.writes_code);
        }
    }
}
