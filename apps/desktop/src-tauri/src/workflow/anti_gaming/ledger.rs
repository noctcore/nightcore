//! The Bash-history half of the sweep: scan the run's flight-recorder ledger for
//! ALLOWED Bash records that carry a standalone `--no-verify` flag — the
//! hook-bypass the diff can't see (a command leaves no diff). Pure over parsed
//! records, like the diff detectors, and folds into the SAME evidence list.

use super::detect::{is_ident, Finding};

/// Cap on the command excerpt quoted in a ledger finding's evidence line — the
/// digest itself is already bounded (~200 chars) by the engine writer.
const MAX_COMMAND_EXCERPT: usize = 120;

/// Scan the run's flight-recorder ledger for the Bash-history half of the sweep
/// (the deferred detector the diff can't cover): any ALLOWED Bash record whose
/// digest carries a standalone `--no-verify` flag — the classic hook/gate
/// bypass. DENIED records are exempt (the rail already held; the blocked-by-
/// policy park gate owns denial accounting), and non-Bash records can't carry a
/// command line. Pure over parsed records, like the diff detectors.
pub(super) fn detect_ledger_findings(
    records: &[crate::store::ledger::LedgerRecord],
) -> Vec<Finding> {
    let mut findings = Vec::new();
    for record in records {
        if record.tool.as_deref() != Some("Bash") || record.decision.as_deref() != Some("allow") {
            continue;
        }
        let Some(digest) = record.input_digest.as_deref() else {
            continue;
        };
        if contains_no_verify(digest) {
            let excerpt: String = digest.chars().take(MAX_COMMAND_EXCERPT).collect();
            findings.push(Finding {
                file: format!("Bash: `{excerpt}`"),
                pattern: "hook bypass: ran a `--no-verify` command".to_string(),
                line: None,
            });
        }
    }
    findings
}

/// A standalone `--no-verify` flag with identifier boundaries on BOTH sides:
/// the char before must not be an identifier char or `-` (so `x--no-verify` and
/// a longer dash run don't count) and the char after must not be an identifier
/// char or `-` (so the DISTINCT git flag `--no-verify-signatures` doesn't fire).
pub(super) fn contains_no_verify(text: &str) -> bool {
    const FLAG: &str = "--no-verify";
    let mut start = 0;
    while let Some(idx) = text[start..].find(FLAG) {
        let abs = start + idx;
        // MSRV 1.77: `is_some_and` + negation instead of `is_none_or` (1.82).
        let breaks_boundary = |c: char| is_ident(c) || c == '-';
        let before_ok = !text[..abs].chars().next_back().is_some_and(breaks_boundary);
        let after_ok = !text[abs + FLAG.len()..]
            .chars()
            .next()
            .is_some_and(breaks_boundary);
        if before_ok && after_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}
