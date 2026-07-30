//! Unit coverage for the computed project summary (#399): the totals it derives,
//! the leniency it inherits, the badge posture, and — most importantly — that it
//! stays COMPUTED (no file is ever written by a read).

use std::path::{Path, PathBuf};

use tempfile::TempDir;

use crate::store::governance::{append, KIND_ARM, KIND_POLICY_SAVE, KIND_QUARANTINE, KIND_RATCHET};
use crate::store::types::StructureLockResult;
use crate::task::Task;

use super::aggregate::{build_summary, MAX_RECENT_EVENTS};
use super::contract::{GauntletTotals, GuardrailTotals, MergeTotals};

const NOW_MS: u64 = 1_785_000_000_000; // 2026-07-24T…Z — a fixed clock for the mint stamp.

fn project() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().expect("temp dir");
    let root = tmp.path().to_path_buf();
    (tmp, root)
}

fn ledger_dir(root: &Path) -> PathBuf {
    crate::store::ledger::ledger_dir(root)
}

/// A task with the gate/merge fields this summary reads.
fn task(merged: bool, verified: bool, gauntlet: Option<bool>, cost: Option<f64>) -> Task {
    let mut t = Task::new("t".into(), String::new());
    t.merged = merged;
    t.verified = verified;
    t.cost_usd = cost;
    t.structure_lock_result = gauntlet.map(|passed| StructureLockResult {
        passed,
        failed_check: (!passed).then(|| "lint".to_string()),
        checks: Vec::new(),
    });
    t
}

/// Write one per-task ledger file.
fn write_ledger(root: &Path, task_id: &str, lines: &[&str]) {
    let dir = ledger_dir(root);
    std::fs::create_dir_all(&dir).expect("ledger dir");
    std::fs::write(dir.join(format!("{task_id}.ndjson")), lines.join("\n")).expect("write ledger");
}

#[test]
fn an_empty_project_summarizes_to_zeroes_and_an_unmeasured_badge() {
    let (_tmp, root) = project();
    let summary = build_summary(&[], &ledger_dir(&root), &root, NOW_MS);

    assert_eq!(summary.merges, MergeTotals::default());
    assert_eq!(summary.gauntlet, GauntletTotals::default());
    assert_eq!(summary.gauntlet.pass_rate, None, "never a misleading 0%");
    assert_eq!(summary.guardrails, GuardrailTotals::default());
    assert_eq!(summary.spend.cost_usd, 0.0);
    assert_eq!(summary.journal.events, 0);
    assert_eq!(summary.badge.message, "not measured");
    assert_eq!(summary.badge.color, "lightgrey");
    assert_eq!(summary.badge.schema_version, 1);
    assert!(
        summary.generated_at.ends_with('Z'),
        "ISO-8601 UTC mint time"
    );
}

#[test]
fn merge_and_gauntlet_totals_only_count_what_actually_ran() {
    let (_tmp, root) = project();
    let tasks = vec![
        task(true, true, Some(true), Some(1.25)), // a verified merge
        task(true, false, Some(true), Some(0.75)), // merged without a reviewer PASS
        task(false, true, Some(false), None),     // verified, not merged, gate failed
        task(false, false, None, Some(0.5)),      // never ran the gauntlet
    ];
    let summary = build_summary(&tasks, &ledger_dir(&root), &root, NOW_MS);

    assert_eq!(
        summary.merges,
        MergeTotals {
            tasks: 4,
            merged: 2,
            verified: 2,
            verified_merges: 1,
        },
        "a merge without a reviewer PASS is not a verified merge"
    );
    assert_eq!(summary.gauntlet.runs, 3, "the never-gated task is excluded");
    assert_eq!(summary.gauntlet.passed, 2);
    assert!((summary.gauntlet.pass_rate.unwrap() - 2.0 / 3.0).abs() < 1e-9);
    assert!((summary.spend.cost_usd - 2.5).abs() < 1e-9);
    assert_eq!(summary.spend.tasks_with_cost, 3);
}

#[test]
fn guardrail_totals_tally_every_ledger_and_attribute_the_rules() {
    let (_tmp, root) = project();
    write_ledger(
        &root,
        "task-1",
        &[
            r#"{"event":"session-start","sessionId":1}"#,
            r#"{"tool":"Bash","inputDigest":"bun test","decision":"allow"}"#,
            r#"{"tool":"Write","inputDigest":"bun.lock","decision":"deny","ruleId":"harness-protected-path"}"#,
            r#"{"tool":"Bash","inputDigest":"curl x","decision":"ask","ruleId":"exec-sink"}"#,
            "not json at all",
        ],
    );
    write_ledger(
        &root,
        "task-2",
        &[
            r#"{"tool":"Write","inputDigest":"migrations/1.sql","decision":"deny","ruleId":"harness-protected-path"}"#,
            r#"{"tool":"Bash","inputDigest":"rm -rf /","decision":"deny","ruleId":"destructive-rm"}"#,
        ],
    );

    let summary = build_summary(&[], &ledger_dir(&root), &root, NOW_MS);
    let g = &summary.guardrails;
    assert_eq!(g.sessions, 2, "both task ledgers contributed");
    assert_eq!(g.tools_evaluated, 5, "the unparseable line is skipped");
    assert_eq!(g.allowed, 1);
    assert_eq!(g.asked, 1);
    assert_eq!(g.denied, 3);
    assert_eq!(
        g.policy_denials, 2,
        "only `harness-*` denials came from THIS project's rules"
    );
    let top = &g.top_rules[0];
    assert_eq!(top.rule_id, "harness-protected-path");
    assert_eq!(top.count, 2);
    assert_eq!(top.source, "policy");
    assert!(
        g.top_rules
            .iter()
            .any(|r| r.rule_id == "destructive-rm" && r.source == "builtin"),
        "a built-in rail is labeled apart from an authored rule: {:?}",
        g.top_rules
    );
}

/// The governance journal shares the ledger dir; it must never be tallied as a
/// session's gate decisions.
#[test]
fn the_governance_journal_is_not_counted_as_a_task_ledger() {
    let (_tmp, root) = project();
    write_ledger(
        &root,
        "task-1",
        &[r#"{"tool":"Bash","inputDigest":"bun test","decision":"allow"}"#],
    );
    append(&root, KIND_POLICY_SAVE, "policy saved", &[]);

    let summary = build_summary(&[], &ledger_dir(&root), &root, NOW_MS);
    assert_eq!(summary.guardrails.sessions, 1, "only the real task ledger");
    assert_eq!(summary.guardrails.tools_evaluated, 1);
    assert_eq!(
        summary.journal.events, 1,
        "…and the journal is read as itself"
    );
}

#[test]
fn the_journal_rolls_up_per_kind_with_a_newest_first_tail() {
    let (_tmp, root) = project();
    append(&root, KIND_POLICY_SAVE, "policy saved", &[]);
    append(
        &root,
        KIND_QUARANTINE,
        "quarantined 1 path(s)",
        &["a.md".into()],
    );
    append(&root, KIND_ARM, "armed check `lint`", &["lint".into()]);
    append(&root, KIND_RATCHET, "ratchet baseline snapshotted", &[]);

    let summary = build_summary(&[], &ledger_dir(&root), &root, NOW_MS);
    let j = &summary.journal;
    assert_eq!(j.events, 4);
    assert_eq!(
        (j.policy_saves, j.quarantines, j.arms, j.ratchets),
        (1, 1, 1, 1)
    );
    assert_eq!(j.disarms, 0);
    assert_eq!(j.other, 0);
    assert_eq!(j.corrupt_lines, 0);
    assert_eq!(
        j.recent.first().map(|e| e.kind.as_str()),
        Some(KIND_RATCHET),
        "the feed is newest first"
    );
    assert_eq!(j.last_event_at.as_ref(), j.recent.first().map(|e| &e.ts));
}

/// Corruption is VISIBLE, and an unknown future kind is counted rather than hidden.
#[test]
fn corrupt_lines_and_unknown_kinds_are_surfaced_not_swallowed() {
    let (_tmp, root) = project();
    append(&root, KIND_ARM, "armed check `lint`", &[]);
    let path = crate::store::governance::journal_path(&root);
    let mut raw = std::fs::read_to_string(&path).expect("journal");
    raw.push_str("{ truncated\n");
    raw.push_str("{\"ts\":\"2027-01-01T00:00:00Z\",\"kind\":\"future-kind\"}\n");
    std::fs::write(&path, raw).expect("rewrite");

    let summary = build_summary(&[], &ledger_dir(&root), &root, NOW_MS);
    assert_eq!(summary.journal.corrupt_lines, 1);
    assert_eq!(summary.journal.other, 1);
    assert_eq!(
        summary.journal.events, 2,
        "the parseable records still count"
    );
}

#[test]
fn the_recent_feed_is_capped_but_the_counts_are_not() {
    let (_tmp, root) = project();
    let total = MAX_RECENT_EVENTS + 12;
    for n in 0..total {
        append(&root, KIND_POLICY_SAVE, &format!("save {n}"), &[]);
    }
    let summary = build_summary(&[], &ledger_dir(&root), &root, NOW_MS);
    assert_eq!(
        summary.journal.policy_saves, total as u32,
        "counts are exact"
    );
    assert_eq!(summary.journal.recent.len(), MAX_RECENT_EVENTS);
    assert_eq!(
        summary.journal.recent[0].summary,
        format!("save {}", total - 1),
        "the cap keeps the NEWEST records"
    );
}

/// The load-bearing invariant of the whole feature: reading the summary must not
/// write anything. A cached summary could drift from the journal it summarizes.
#[test]
fn building_the_summary_writes_nothing() {
    let (_tmp, root) = project();
    append(&root, KIND_ARM, "armed check `lint`", &[]);
    write_ledger(
        &root,
        "task-1",
        &[r#"{"tool":"Bash","inputDigest":"bun test","decision":"allow"}"#],
    );

    let before = snapshot_tree(&root);
    let a = build_summary(
        &[task(true, true, Some(true), Some(1.0))],
        &ledger_dir(&root),
        &root,
        NOW_MS,
    );
    let b = build_summary(
        &[task(true, true, Some(true), Some(1.0))],
        &ledger_dir(&root),
        &root,
        NOW_MS,
    );
    assert_eq!(
        snapshot_tree(&root),
        before,
        "a read created or changed a file"
    );

    // …and it is deterministic for a fixed clock + inputs.
    assert_eq!(
        serde_json::to_string(&a).unwrap(),
        serde_json::to_string(&b).unwrap()
    );
}

/// Every file under `root` with its byte length — enough to catch a create, a
/// delete, or an in-place rewrite.
fn snapshot_tree(root: &Path) -> Vec<(PathBuf, u64)> {
    fn walk(dir: &Path, out: &mut Vec<(PathBuf, u64)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if let Ok(meta) = entry.metadata() {
                out.push((path, meta.len()));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, &mut out);
    out.sort();
    out
}

// ─── Badge posture ──────────────────────────────────────────────────────────────

fn badge_for(
    verified_merges: u32,
    runs: u32,
    passed: u32,
    denied: u32,
) -> super::contract::TrustBadge {
    let merges = MergeTotals {
        tasks: runs,
        merged: verified_merges,
        verified: verified_merges,
        verified_merges,
    };
    let gauntlet = GauntletTotals {
        runs,
        passed,
        pass_rate: (runs > 0).then(|| f64::from(passed) / f64::from(runs)),
    };
    let guardrails = GuardrailTotals {
        denied,
        ..GuardrailTotals::default()
    };
    super::badge::build_badge(&merges, &gauntlet, &guardrails)
}

#[test]
fn the_badge_colour_tracks_the_gauntlet_pass_rate() {
    assert_eq!(badge_for(4, 20, 20, 0).color, "brightgreen");
    assert_eq!(badge_for(4, 20, 18, 0).color, "green");
    assert_eq!(badge_for(4, 10, 7, 0).color, "yellow");
    assert_eq!(badge_for(4, 10, 2, 0).color, "orange");
    // A perfect rate with NOTHING verified-merged is green, not brightgreen — the
    // strongest posture requires evidence that something actually shipped.
    assert_eq!(badge_for(0, 20, 20, 0).color, "green");
    // No gauntlet history at all ⇒ honest "not measured", never a green claim.
    assert_eq!(badge_for(0, 0, 0, 0).color, "lightgrey");
}

#[test]
fn the_badge_message_leads_with_verified_merges_and_pluralizes() {
    assert_eq!(
        badge_for(1, 4, 4, 0).message,
        "1 verified merge · 100% gauntlet"
    );
    assert_eq!(
        badge_for(3, 4, 3, 0).message,
        "3 verified merges · 75% gauntlet"
    );
    assert_eq!(
        badge_for(3, 4, 3, 1).message,
        "3 verified merges · 75% gauntlet · 1 denial",
        "denials ride along only when there are any"
    );
    assert!(badge_for(3, 4, 3, 5).message.ends_with("5 denials"));
}

/// The badge on the summary IS the exported badge — one function, so a published
/// badge can never claim something the dashboard contradicts.
#[test]
fn the_exported_badge_is_the_summary_badge() {
    let (_tmp, root) = project();
    let summary = build_summary(
        &[task(true, true, Some(true), None)],
        &ledger_dir(&root),
        &root,
        NOW_MS,
    );
    assert_eq!(super::badge_of(&summary), &summary.badge);
    assert_eq!(summary.badge.label, "governance");
    assert_eq!(summary.badge.color, "brightgreen");
}
