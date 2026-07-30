//! Pure aggregation of a [`ProjectTrustSummary`] from three already-persisted
//! sources: the task store (gate verdicts + spend), the per-task flight-recorder
//! ledgers (guardrail tiers), and the governance journal (human decisions).
//!
//! COMPUTED ON DEMAND, never cached — see the contract module header. Pure over its
//! inputs (the caller supplies the tasks and the paths), so it unit-tests headlessly
//! exactly like `workflow::trust::aggregate`.

use std::collections::HashMap;
use std::path::Path;

use crate::infra::time::iso8601_utc;
use crate::store::governance::{
    read_journal, GovernanceEvent, JOURNAL_FILE, KIND_ARM, KIND_DISARM, KIND_POLICY_SAVE,
    KIND_QUARANTINE, KIND_RATCHET,
};
use crate::store::ledger::{read_records, LedgerRecord};
use crate::task::Task;

use super::badge::build_badge;
use super::contract::{
    GauntletTotals, GuardrailTotals, JournalSummary, MergeTotals, ProjectTrustSummary, RuleTally,
    SpendTotals, TrustBadge,
};

/// How many rules the badge/dashboard names. The tallies stay exact; only the
/// printed list is bounded (the `blocked_by_policy_message` capping posture).
const MAX_TOP_RULES: usize = 8;

/// How many journal records ride along on the summary. The COUNTS cover the whole
/// journal; this bounds only the rendered feed so a long-lived project can't stall
/// the webview (the `POLICY_ACTIVITY_LIMIT` posture).
pub(super) const MAX_RECENT_EVENTS: usize = 50;

/// The rule-id prefix every rule from this project's own harness policy carries;
/// everything else is a built-in engine rail the author cannot edit.
const POLICY_RULE_PREFIX: &str = "harness-";
const SOURCE_POLICY: &str = "policy";
const SOURCE_BUILTIN: &str = "builtin";

/// Build the repo-scoped summary. `tasks` is the whole task store, `ledger_dir` the
/// project's flight-recorder directory, and `project_root` the dir holding
/// `.nightcore/` (the governance journal's home).
pub(crate) fn build_summary(
    tasks: &[Task],
    ledger_dir: &Path,
    project_root: &Path,
    now_ms: u64,
) -> ProjectTrustSummary {
    let merges = merge_totals(tasks);
    let gauntlet = gauntlet_totals(tasks);
    let guardrails = guardrail_totals(ledger_dir);
    let badge = build_badge(&merges, &gauntlet, &guardrails);

    ProjectTrustSummary {
        generated_at: iso8601_utc(now_ms),
        merges,
        gauntlet,
        guardrails,
        spend: spend_totals(tasks),
        journal: journal_summary(project_root),
        badge,
    }
}

/// The badge alone, for the export command — same inputs, same function, so a
/// published badge can never disagree with the dashboard.
pub(crate) fn badge_of(summary: &ProjectTrustSummary) -> &TrustBadge {
    &summary.badge
}

fn merge_totals(tasks: &[Task]) -> MergeTotals {
    let mut totals = MergeTotals {
        tasks: tasks.len() as u32,
        ..MergeTotals::default()
    };
    for task in tasks {
        if task.merged {
            totals.merged += 1;
        }
        if task.verified {
            totals.verified += 1;
        }
        if task.merged && task.verified {
            totals.verified_merges += 1;
        }
    }
    totals
}

fn gauntlet_totals(tasks: &[Task]) -> GauntletTotals {
    let mut totals = GauntletTotals::default();
    for task in tasks {
        // Only tasks the battery actually ran against count — using every task as
        // the denominator would report a pass rate that mostly measures how many
        // cards sit in the backlog.
        let Some(result) = task.structure_lock_result.as_ref() else {
            continue;
        };
        totals.runs += 1;
        if result.passed {
            totals.passed += 1;
        }
    }
    totals.pass_rate = (totals.runs > 0).then(|| f64::from(totals.passed) / f64::from(totals.runs));
    totals
}

fn spend_totals(tasks: &[Task]) -> SpendTotals {
    let mut totals = SpendTotals::default();
    for cost in tasks.iter().filter_map(|t| t.cost_usd) {
        totals.cost_usd += cost;
        totals.tasks_with_cost += 1;
    }
    totals
}

/// Walk every per-task ledger and tally the gate decisions. Lenient throughout: a
/// missing dir yields zeros, an unreadable file is skipped, an unparseable line is
/// dropped — an evidence surface must never error.
fn guardrail_totals(ledger_dir: &Path) -> GuardrailTotals {
    let mut totals = GuardrailTotals::default();
    let mut by_rule: HashMap<String, u32> = HashMap::new();

    let Ok(dir) = std::fs::read_dir(ledger_dir) else {
        return totals;
    };
    for file in dir.flatten() {
        let path = file.path();
        if path.extension().and_then(|e| e.to_str()) != Some("ndjson") {
            continue;
        }
        // The governance journal shares this dir but is not a gate ledger.
        if path.file_name().and_then(|n| n.to_str()) == Some(JOURNAL_FILE) {
            continue;
        }
        totals.sessions += 1;
        for record in read_records(&path) {
            tally_record(&record, &mut totals, &mut by_rule);
        }
    }

    let mut top: Vec<RuleTally> = by_rule
        .into_iter()
        .map(|(rule_id, count)| {
            let source = if rule_id.starts_with(POLICY_RULE_PREFIX) {
                SOURCE_POLICY
            } else {
                SOURCE_BUILTIN
            };
            RuleTally {
                rule_id,
                count,
                source: source.to_string(),
            }
        })
        .collect();
    // Count descending, then rule id, so the order is deterministic for a snapshot.
    top.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.rule_id.cmp(&b.rule_id))
    });
    top.truncate(MAX_TOP_RULES);
    totals.top_rules = top;
    totals
}

/// Fold one ledger record into the running tallies. Marker lines (`session-start`
/// and friends) carry no `decision` and contribute nothing.
fn tally_record(
    record: &LedgerRecord,
    totals: &mut GuardrailTotals,
    by_rule: &mut HashMap<String, u32>,
) {
    let Some(decision) = record.decision.as_deref() else {
        return;
    };
    match decision {
        "allow" => totals.allowed += 1,
        "ask" => totals.asked += 1,
        "deny" => {
            totals.denied += 1;
            if record.is_harness_policy_denial() {
                totals.policy_denials += 1;
            }
        }
        // An unknown future tier still counts as an evaluation, but nothing else.
        _ => {}
    }
    totals.tools_evaluated += 1;

    // Rule attribution covers the two tiers that carry a WHY (deny + ask).
    if decision == "deny" || decision == "ask" {
        if let Some(rule_id) = record.rule_id.as_deref().filter(|id| !id.is_empty()) {
            *by_rule.entry(rule_id.to_string()).or_default() += 1;
        }
    }
}

/// Roll the governance journal up: exact per-kind counts over the WHOLE journal,
/// plus a bounded newest-first tail for the feed.
fn journal_summary(project_root: &Path) -> JournalSummary {
    let read = read_journal(project_root);
    let mut summary = JournalSummary {
        events: read.events.len() as u32,
        corrupt_lines: read.corrupt_lines,
        ..JournalSummary::default()
    };
    for event in &read.events {
        match event.kind.as_str() {
            KIND_QUARANTINE => summary.quarantines += 1,
            KIND_POLICY_SAVE => summary.policy_saves += 1,
            KIND_ARM => summary.arms += 1,
            KIND_DISARM => summary.disarms += 1,
            KIND_RATCHET => summary.ratchets += 1,
            _ => summary.other += 1,
        }
    }
    // The journal is append-only, so the LAST record is the newest — no sort needed.
    summary.last_event_at = read.events.last().map(|e| e.ts.clone());
    summary.recent = read
        .events
        .into_iter()
        .rev()
        .take(MAX_RECENT_EVENTS)
        .collect::<Vec<GovernanceEvent>>();
    summary
}
