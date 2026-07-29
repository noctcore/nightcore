//! The Policy activity feed (issue #400) — the read side of the flight recorder,
//! aggregated ACROSS tasks for the policy authoring surface.
//!
//! WHY THIS EXISTS. Every PreToolUse gate evaluation is already recorded by the
//! engine's session ledger ([`crate::store::ledger`]), but the only readers were
//! deterministic gates: the anti-gaming sweep, the blocked-by-policy park gate,
//! and the per-task Trust Report. So a project's rails were invisible until the
//! moment they parked a task — the author could not see that their `--no-verify`
//! rule had fired eleven times this week, nor that a rule they believed was armed
//! had never fired at all. This module aggregates the ledger dir into a
//! newest-first feed of DENY/ASK decisions with their rule attribution, so the
//! Policy tab can show the rails actually working.
//!
//! POSTURE. Read-only and lenient, inheriting the recorder's own discipline: a
//! missing ledger dir yields an empty feed, an unreadable file is skipped, and an
//! unparseable line is dropped without failing its siblings — an evidence surface
//! must never error. Only records the recorder already redacted and truncated are
//! surfaced (`inputDigest` is at most ~200 chars of ONE field, secret-redacted at
//! write time by `redactSecrets`), so this adds no new exposure over the ledger
//! file itself. ALLOW records are dropped: the feed is about the rails firing,
//! and a full audit trail is the Trust Report's job.

use std::path::Path;

use serde::{Deserialize, Serialize};
#[cfg(test)]
use ts_rs::TS;

use crate::store::ledger::read_records;

/// The shared prefix of every rule id the project's own harness policy emits
/// (`harness-protected-path`, `harness-bash-deny`, `harness-read-deny`,
/// `harness-tool-deny`, `harness-tool-ask`). Everything else is a BUILT-IN rail
/// (the destructive deny list, workspace confinement, the exec-sink ask), which
/// the author cannot edit — so the feed labels the two apart rather than implying
/// a denial came from a rule they wrote.
const POLICY_RULE_PREFIX: &str = "harness-";

/// Feed source: `policy` = a rule from this project's `.nightcore/harness.json`,
/// `builtin` = one of the engine's own always-on rails.
const SOURCE_POLICY: &str = "policy";
const SOURCE_BUILTIN: &str = "builtin";

/// How many entries the feed returns at most, newest first. A long-running
/// project accumulates tens of thousands of ledger lines; the authoring surface
/// only ever renders the recent tail, and an unbounded IPC payload would stall
/// the webview.
pub const POLICY_ACTIVITY_LIMIT: usize = 200;

/// One gate decision the author can act on. Flat and computed-on-demand (never
/// persisted — the ledger already is the record), mirroring the Trust Report's
/// posture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "PolicyActivityEntry.ts"))]
pub struct PolicyActivityEntry {
    /// Stable React key: `<task id>:<line index>`. The ledger is append-only, so
    /// a record's position in its file never changes.
    pub id: String,
    /// The task whose session hit the rail (the ledger file's stem).
    pub task_id: String,
    /// The task's title when the store still holds it — a task deleted after its
    /// ledger was written leaves `None` rather than dropping the evidence.
    pub task_title: Option<String>,
    /// ISO-8601 UTC timestamp the engine stamped at enqueue. `None` for a record
    /// written before the recorder carried `ts` (serde-additive).
    pub ts: Option<String>,
    /// The SDK tool that was called.
    pub tool: String,
    /// The recorder's already-redacted, already-truncated digest of the single
    /// most relevant input field (the bash command line, or the target path).
    pub input_digest: String,
    /// `deny` | `ask`.
    pub decision: String,
    /// The rule that decided — the WHY. `harness-protected-path`,
    /// `network-exfiltration`, `workspace-confinement`, …
    pub rule_id: String,
    /// `policy` (a rule from this project's manifest) | `builtin` (an engine rail).
    pub source: String,
}

/// Read the newest {@link POLICY_ACTIVITY_LIMIT} deny/ask decisions across every
/// task ledger under `ledger_dir`.
///
/// Sorted by timestamp DESCENDING, with records missing a `ts` sorted last (they
/// predate the field, so they are the oldest by definition). Ties keep their
/// within-file order reversed, so the newest line of a session leads.
pub fn read_policy_activity(
    ledger_dir: &Path,
    resolve_title: &dyn Fn(&str) -> Option<String>,
) -> Vec<PolicyActivityEntry> {
    let Ok(dir) = std::fs::read_dir(ledger_dir) else {
        // No ledger dir yet (a project that has never run a session) ⇒ no activity.
        return Vec::new();
    };

    let mut entries: Vec<PolicyActivityEntry> = Vec::new();
    for file in dir.flatten() {
        let path = file.path();
        if path.extension().and_then(|e| e.to_str()) != Some("ndjson") {
            continue;
        }
        let Some(task_id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let title = resolve_title(task_id);
        for (index, record) in read_records(&path).into_iter().enumerate() {
            let decision = record.decision.as_deref().unwrap_or_default();
            if decision != "deny" && decision != "ask" {
                continue;
            }
            // A decision with no rule id carries no WHY, so it cannot be
            // attributed — the one thing this feed exists to show.
            let Some(rule_id) = record.rule_id.filter(|id| !id.is_empty()) else {
                continue;
            };
            let source = if rule_id.starts_with(POLICY_RULE_PREFIX) {
                SOURCE_POLICY
            } else {
                SOURCE_BUILTIN
            };
            entries.push(PolicyActivityEntry {
                id: format!("{task_id}:{index}"),
                task_id: task_id.to_string(),
                task_title: title.clone(),
                ts: record.ts,
                tool: record.tool.unwrap_or_default(),
                input_digest: record.input_digest.unwrap_or_default(),
                decision: decision.to_string(),
                rule_id,
                source: source.to_string(),
            });
        }
    }

    // Newest first. `ts` is ISO-8601 UTC from one writer, so lexicographic order
    // IS chronological order; a missing `ts` sorts last (empty string is least).
    entries.sort_by(|a, b| {
        b.ts.as_deref()
            .unwrap_or_default()
            .cmp(a.ts.as_deref().unwrap_or_default())
    });
    entries.truncate(POLICY_ACTIVITY_LIMIT);
    entries
}

#[cfg(test)]
mod tests;
