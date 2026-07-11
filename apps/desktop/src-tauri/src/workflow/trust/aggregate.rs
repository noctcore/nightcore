//! Pure aggregation of a `TrustReport` from the three already-persisted stores:
//! the `Task` (gauntlet + reviewer verdict, verbatim), the flight-recorder ledger
//! (guardrail tiers + session markers + touched files/commands), and the
//! transcript (summed cost/tokens). ZERO new persistence, zero new writers — the
//! report is minted per request and returned.
//!
//! [`build_report`] is pure over its inputs (mirrors the diff-budget / anti-gaming
//! "pure over parsed records" posture): it reads the task, calls
//! `store::ledger::read_records` + `store::transcript::cost_summary`, and never
//! touches git or a running engine — so it unit-tests headlessly.

use std::path::Path;

// The ISO-8601 UTC formatter lives in `infra::time` (rank 1) so the usage poller
// (issue #121) can reuse it too; re-exported at `super::aggregate::iso8601_utc` so
// the existing call site + `trust::tests` resolve unchanged.
pub(super) use crate::infra::time::iso8601_utc;
use crate::store::ledger::{blocked_by_policy_message_from, read_records, LedgerRecord};
use crate::store::transcript::{cost_summary, CostSummary};
use crate::task::{Task, TaskStatus};

use super::contract::{
    FlightSummary, GauntletTrust, GuardrailEvent, GuardrailTrust, TokenTotals, TrustReport,
};

/// Cap on the enumerated files/commands surfaced on the receipt — the counts stay
/// exact (`*_count`), only the printed list is bounded so a runaway run can't blow
/// up the report (the `blocked_by_policy_message` capping posture).
const MAX_LISTED: usize = 50;

/// The tools whose ledger `input_digest` is a touched-FILE path.
const WRITE_TOOLS: [&str; 4] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/// Build the per-task Trust Report from the persisted task, its flight-recorder
/// ledger, and its transcript. Pure over the three inputs — no git, no engine.
pub(crate) fn build_report(task: &Task, ledger_path: &Path, tasks_dir: &Path) -> TrustReport {
    let records = read_records(ledger_path);
    let cost = cost_summary(tasks_dir, &task.id);

    TrustReport {
        task_id: task.id.clone(),
        // The title is UNTRUSTED for a scan-minted task; collapse it to one
        // printable line before it becomes a heading (the render fences the rest).
        title: crate::task::sanitize_minted_title(&task.title, "Untitled task"),
        status: task.status,
        run_mode: task.run_mode,
        branch: task.branch.clone(),
        base_branch: task.base_branch.clone(),
        pr_url: task.pr_url.clone(),
        pr_number: task.pr_number,
        generated_at: iso8601_utc(crate::task::now_ms()),
        gauntlet: gauntlet_trust(task),
        guardrails: guardrail_trust(task, &records),
        flight: flight_summary(task, &records, cost),
        // v1 seam: quarantine is never populated (§3.1).
        quarantine: Vec::new(),
    }
}

/// The gauntlet + reviewer section, read VERBATIM off the task (never re-run).
fn gauntlet_trust(task: &Task) -> GauntletTrust {
    GauntletTrust {
        verified: task.verified,
        verdict: extract_verdict_line(task.review.as_deref()),
        review: task.review.clone(),
        fix_attempts: task.fix_attempts,
        structure_lock: task.structure_lock_result.clone(),
    }
}

/// Extract the reviewer's machine-readable `VERDICT: …` line from the full review
/// text — the LAST match wins (the final verdict is authoritative), mirroring the
/// `parse_verdict` idiom (`sidecar/verification/verdict.rs`) but returning the
/// literal line for display. Reimplemented here rather than imported: `workflow`
/// may not reach up into `sidecar` (the layer-rank seam).
fn extract_verdict_line(review: Option<&str>) -> Option<String> {
    let review = review?;
    review
        .lines()
        .rfind(|line| line.contains("VERDICT:"))
        .map(|line| line.trim().to_string())
}

/// The guardrail section, derived from the ledger decisions.
fn guardrail_trust(task: &Task, records: &[LedgerRecord]) -> GuardrailTrust {
    let mut allowed = 0u32;
    let mut asked = 0u32;
    let mut denied = 0u32;
    let mut tools_evaluated = 0u32;
    let mut blocked: Vec<GuardrailEvent> = Vec::new();
    let mut asked_events: Vec<GuardrailEvent> = Vec::new();

    for r in records {
        match r.decision.as_deref() {
            Some("allow") => {
                allowed += 1;
                tools_evaluated += 1;
            }
            Some("ask") => {
                asked += 1;
                tools_evaluated += 1;
                asked_events.push(guardrail_event(r));
            }
            Some("deny") => {
                denied += 1;
                tools_evaluated += 1;
                blocked.push(guardrail_event(r));
            }
            // A marker line (`session-start`/…) or an unknown decision: still count
            // it as an evaluated decision if it carried one, else ignore.
            Some(_) => tools_evaluated += 1,
            None => {}
        }
    }

    GuardrailTrust {
        tools_evaluated,
        allowed,
        asked,
        denied,
        blocked,
        asked_events,
        // Reuse the records already parsed above instead of re-reading and
        // re-parsing the ledger from `ledger_path` a second time (perf #206).
        policy_hold: blocked_by_policy_message_from(records),
        scope_park: scope_park(task),
    }
}

/// One guardrail event from a ledger decision record.
fn guardrail_event(r: &LedgerRecord) -> GuardrailEvent {
    GuardrailEvent {
        tool: r.tool.clone().unwrap_or_else(|| "unknown".to_string()),
        rule_id: r.rule_id.clone(),
        digest: r.input_digest.clone(),
        ts: r.ts.clone(),
        decision: r.decision.clone().unwrap_or_default(),
    }
}

/// A diff-budget / policy park message, surfaced ONLY while the task is still
/// parked for it (§3.4) — transient, best-effort, labeled as such in the render.
fn scope_park(task: &Task) -> Option<String> {
    if task.status != TaskStatus::WaitingApproval {
        return None;
    }
    let err = task.error.as_deref()?.trim();
    // The two park messages a run writes to `Task.error` (diff_budget::evaluate,
    // ledger::blocked_by_policy_message). Any OTHER waiting-approval error (a plan
    // gate, a manual hold) is not a scope park.
    if err.starts_with("diff budget exceeded") || err.starts_with("blocked by harness policy") {
        Some(err.to_string())
    } else {
        None
    }
}

/// The flight-recorder summary: session count, touched files, commands, cost.
fn flight_summary(
    task: &Task,
    records: &[LedgerRecord],
    cost: Option<CostSummary>,
) -> FlightSummary {
    let session_count = records
        .iter()
        .filter(|r| r.event.as_deref() == Some("session-start"))
        .count() as u32;

    // Files touched: deduped Write/Edit/MultiEdit/NotebookEdit digests, first-seen
    // order. The count is over DISTINCT files (pre-cap); the list is bounded.
    let mut files: Vec<String> = Vec::new();
    let mut commands: Vec<String> = Vec::new();
    for r in records {
        let Some(tool) = r.tool.as_deref() else {
            continue;
        };
        let Some(digest) = r.input_digest.as_deref().filter(|d| !d.is_empty()) else {
            continue;
        };
        if WRITE_TOOLS.contains(&tool) {
            if !files.iter().any(|f| f == digest) {
                files.push(digest.to_string());
            }
        } else if tool == "Bash" {
            commands.push(digest.to_string());
        }
    }
    let files_touched_count = files.len() as u32;
    let commands_count = commands.len() as u32;
    files.truncate(MAX_LISTED);
    commands.truncate(MAX_LISTED);

    FlightSummary {
        session_count,
        files_touched: files,
        files_touched_count,
        commands,
        commands_count,
        cost_usd_last_run: task.cost_usd,
        cost_usd_total: cost.map(|c| c.cost_usd),
        tokens: cost.map(|c| TokenTotals {
            input: c.input_tokens,
            output: c.output_tokens,
            reasoning_output: c.reasoning_output_tokens,
            cache_read: c.cache_read_tokens,
            cache_creation: c.cache_creation_tokens,
        }),
    }
}
