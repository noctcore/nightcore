//! Small, dependency-free text helpers shared across tiers.
//!
//! Lives in `infra` (rank 2) so leaf/engine callers can depend DOWNWARD on it
//! instead of reaching sideways into an engine module for a string utility.
//! [`tail_output`] was hoisted here from `workflow::gauntlet::run` (issue #17
//! phase A.3): the gauntlet, the Structure-Lock gauntlet, and `worktree`
//! provisioning all truncate subprocess output identically, and `worktree`
//! (rank 3) must not import the rank-5 workflow tier for it.

/// How much of a failing step's output to retain for the UI. Bounded so a noisy
/// failure can't bloat the event payload; truncated from the tail (the part that
/// usually names the failure).
const TAIL_LIMIT: usize = 4000;

/// Combine stdout+stderr and keep the last [`TAIL_LIMIT`] bytes (the part that
/// usually names the failure), as UTF-8-lossy text. Shared by the gauntlet, the
/// Structure-Lock gauntlet (`gauntlet_project`), and worktree provisioning so
/// every gate truncates identically.
pub(crate) fn tail_output(stdout: &[u8], stderr: &[u8]) -> String {
    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(stdout));
    if !stderr.is_empty() {
        combined.push('\n');
        combined.push_str(&String::from_utf8_lossy(stderr));
    }
    if combined.len() > TAIL_LIMIT {
        let start = combined.len() - TAIL_LIMIT;
        // Snap to a char boundary so we never slice mid-codepoint.
        let start = (start..combined.len())
            .find(|&i| combined.is_char_boundary(i))
            .unwrap_or(combined.len());
        format!("…{}", &combined[start..])
    } else {
        combined
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combines_streams_and_passes_short_output_through() {
        assert_eq!(tail_output(b"out", b"err"), "out\nerr");
        assert_eq!(tail_output(b"out", b""), "out");
    }

    #[test]
    fn truncates_from_the_tail_on_a_char_boundary() {
        // A payload longer than the limit keeps only the tail, prefixed with '…',
        // and never slices mid-codepoint.
        let big = "é".repeat(TAIL_LIMIT); // 2 bytes each ⇒ well over the limit
        let out = tail_output(big.as_bytes(), b"");
        assert!(out.starts_with('…'), "truncated output is tail-marked");
        assert!(out.len() <= TAIL_LIMIT + '…'.len_utf8() + 1);
        // Every retained byte is valid UTF-8 (no mid-codepoint slice).
        assert!(out.chars().skip(1).all(|c| c == 'é'));
    }
}
