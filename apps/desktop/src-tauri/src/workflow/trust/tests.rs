//! Unit tests for the Trust Report: the pure aggregator over a fixture ledger,
//! empty-ledger/missing-transcript degradation, the canonical renderer against
//! HOSTILE untrusted strings, the cost-summer under-count label, and the
//! serde-additive `quarantine` seam round-trip. All hermetic — synthetic task +
//! ledger + transcript, no git and no running engine (the diff-budget / anti-gaming
//! "pure over parsed records" posture).

use std::path::{Path, PathBuf};

use tempfile::TempDir;

use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};
use crate::store::TaskStore;
use crate::task::{RunMode, Task, TaskStatus};

use super::aggregate::iso8601_utc;
use super::build_report;
use super::contract::TrustReport;
use super::render::{code_span, longest_backtick_run};
use super::{render_for_github, render_markdown};

/// Clone the ledger test harness (`store::ledger::write_ledger`): write NDJSON
/// lines to a temp file and hand back its path.
fn write_ledger(lines: &[&str]) -> (TempDir, PathBuf) {
    let tmp = TempDir::new().expect("temp dir");
    let path = tmp.path().join("task.ndjson");
    std::fs::write(&path, lines.join("\n")).expect("write ledger");
    (tmp, path)
}

/// A structure-lock result with one passing + one failing check (so the render
/// exercises both branches and the failed-check name).
fn structure_lock() -> StructureLockResult {
    StructureLockResult {
        passed: false,
        checks: vec![
            StructureLockCheck {
                name: "folder-per-component".into(),
                kind: "lint-plugin".into(),
                command: "bun run lint".into(),
                status: StepStatus::Passed,
                exit_code: Some(0),
                output: None,
            },
            StructureLockCheck {
                name: "coverage".into(),
                kind: "coverage-threshold".into(),
                command: "bun run coverage".into(),
                status: StepStatus::Failed,
                exit_code: Some(1),
                output: Some("below threshold".into()),
            },
        ],
        failed_check: Some("coverage".into()),
    }
}

/// A synthetic verified task with a populated gauntlet + reviewer verdict + cost.
fn synthetic_task() -> Task {
    let mut t = Task::new("Ship the widget".into(), String::new());
    t.status = TaskStatus::Done;
    t.run_mode = RunMode::Worktree;
    t.branch = Some("nc/xyz".into());
    t.base_branch = Some("main".into());
    t.verified = true;
    t.review = Some("Looks good overall.\nVERDICT: PASS — solid".into());
    t.fix_attempts = 2;
    t.structure_lock_result = Some(structure_lock());
    t.cost_usd = Some(1.5);
    t.pr_url = Some("https://github.com/acme/widget/pull/7".into());
    t.pr_number = Some(7);
    t
}

#[test]
fn aggregates_over_a_fixture_ledger() {
    let (_tmp, ledger) = write_ledger(&[
        r#"{"ts":"2026-07-10T00:00:00Z","event":"session-start","sessionId":1}"#,
        r#"{"ts":"2026-07-10T00:00:01Z","tool":"Write","inputDigest":"src/a.rs","decision":"allow"}"#,
        r#"{"ts":"2026-07-10T00:00:02Z","tool":"Edit","inputDigest":"src/a.rs","decision":"allow"}"#,
        r#"{"ts":"2026-07-10T00:00:03Z","tool":"Bash","inputDigest":"bun test","decision":"allow"}"#,
        r#"{"ts":"2026-07-10T00:00:04Z","tool":"Bash","inputDigest":"git push --force","decision":"deny","ruleId":"harness-bash-deny"}"#,
        r#"{"ts":"2026-07-10T00:00:05Z","tool":"Write","inputDigest":"bun.lock","decision":"deny","ruleId":"harness-protected-path"}"#,
        r#"{"ts":"2026-07-10T00:00:06Z","tool":"Read","inputDigest":"/etc/hosts","decision":"ask"}"#,
        r#"{"ts":"2026-07-10T00:00:07Z","event":"session-end","sessionId":1}"#,
    ]);
    let task = synthetic_task();
    let store_tmp = TempDir::new().unwrap(); // no transcript ⇒ cost aggregate is None
    let report = build_report(&task, &ledger, store_tmp.path());

    // Guardrail decision counts.
    let g = &report.guardrails;
    assert_eq!((g.allowed, g.asked, g.denied), (3, 1, 2));
    assert_eq!(g.tools_evaluated, 6);
    assert_eq!(g.blocked.len(), 2, "both deny records land in blocked");
    assert_eq!(g.asked_events.len(), 1);
    assert_eq!(g.asked_events[0].tool, "Read");
    assert_eq!(
        g.asked_events[0].ts.as_deref(),
        Some("2026-07-10T00:00:06Z"),
        "the additive ts parse surfaces per-event timestamps"
    );
    assert!(
        g.policy_hold.is_some(),
        "a protected-path denial derives the policy hold"
    );
    assert!(g.scope_park.is_none(), "the task isn't parked");

    // Flight summary.
    let f = &report.flight;
    assert_eq!(f.session_count, 1, "one session-start marker");
    assert_eq!(
        f.files_touched,
        vec!["src/a.rs".to_string(), "bun.lock".to_string()],
        "Write + Edit of the same path dedupe; a denied write still counts by tool"
    );
    assert_eq!(f.files_touched_count, 2);
    assert_eq!(
        f.commands,
        vec!["bun test".to_string(), "git push --force".to_string()],
        "Bash digests collected in order"
    );
    assert_eq!(f.commands_count, 2);
    assert_eq!(f.cost_usd_last_run, Some(1.5));
    assert!(
        f.cost_usd_total.is_none() && f.tokens.is_none(),
        "no transcript ⇒ no aggregate cost/tokens"
    );

    // Gauntlet mirrors the task verbatim (never re-run).
    let ga = &report.gauntlet;
    assert!(ga.verified);
    assert_eq!(ga.verdict.as_deref(), Some("VERDICT: PASS — solid"));
    assert_eq!(ga.fix_attempts, 2);
    assert!(ga.structure_lock.is_some());

    // Provenance: a verifiable ISO mint time + branch/PR.
    assert!(report.generated_at.ends_with('Z'));
    assert_eq!(report.generated_at.len(), 20, "YYYY-MM-DDTHH:MM:SSZ");
    assert_eq!(report.branch.as_deref(), Some("nc/xyz"));
    assert_eq!(report.pr_number, Some(7));
    assert!(
        report.quarantine.is_empty(),
        "v1: quarantine seam stays empty"
    );
}

#[test]
fn policy_hold_absent_and_scope_park_only_when_parked() {
    let (_tmp, ledger) = write_ledger(&[
        r#"{"event":"session-start"}"#,
        r#"{"tool":"Bash","inputDigest":"bun test","decision":"allow"}"#,
    ]);
    let store_tmp = TempDir::new().unwrap();

    let mut task = synthetic_task();
    let report = build_report(&task, &ledger, store_tmp.path());
    assert!(
        report.guardrails.policy_hold.is_none(),
        "no protected-path denial ⇒ no policy hold (mirror the ledger park test)"
    );
    assert!(report.guardrails.scope_park.is_none());

    // Parked for a diff-budget breach: the transient park is surfaced.
    task.status = TaskStatus::WaitingApproval;
    task.error = Some(
        "diff budget exceeded: 900 changed lines (budget 400) — review scope before verifying"
            .into(),
    );
    let parked = build_report(&task, &ledger, store_tmp.path());
    assert!(parked
        .guardrails
        .scope_park
        .as_deref()
        .unwrap()
        .starts_with("diff budget exceeded"));

    // A non-park waiting-approval error (a plan hold) is NOT a scope park.
    task.error = Some("awaiting your approval of the plan".into());
    let held = build_report(&task, &ledger, store_tmp.path());
    assert!(held.guardrails.scope_park.is_none());
}

#[test]
fn empty_or_missing_ledger_degrades_to_zeros() {
    let task = synthetic_task();
    let store_tmp = TempDir::new().unwrap();
    // A ledger path that does not exist ⇒ no records (the pre-recorder shape).
    let report = build_report(&task, Path::new("/no/such/ledger.ndjson"), store_tmp.path());
    let g = &report.guardrails;
    assert_eq!(
        (g.tools_evaluated, g.allowed, g.asked, g.denied),
        (0, 0, 0, 0)
    );
    assert!(g.blocked.is_empty() && g.asked_events.is_empty());
    assert!(g.policy_hold.is_none());
    assert_eq!(report.flight.session_count, 0);
    assert!(report.flight.files_touched.is_empty() && report.flight.commands.is_empty());
    // The gauntlet section is ledger-independent (persisted on the task).
    assert!(report.gauntlet.verified);
}

#[test]
fn build_report_totals_transcript_cost_and_labels_the_undercount() {
    let tmp = TempDir::new().unwrap();
    let store = TaskStore::load_from(tmp.path().join("tasks"));
    let task = synthetic_task();
    store.upsert(&task).expect("upsert");

    // Two completed sessions in the transcript (no tokio runtime ⇒ synchronous write).
    for ev in [
        serde_json::json!({"type":"session-completed","costUsd":0.2,
            "usage":{"inputTokens":100,"outputTokens":10}}),
        serde_json::json!({"type":"session-completed","costUsd":0.3,
            "usage":{"inputTokens":50,"outputTokens":5}}),
    ] {
        crate::store::transcript::append_line(&store, &task.id, &ev.to_string());
    }

    let (_led, ledger) = write_ledger(&[
        r#"{"event":"session-start"}"#,
        r#"{"event":"session-start"}"#,
    ]);
    let report = build_report(&task, &ledger, &store.tasks_dir());

    assert_eq!(
        report.flight.session_count, 2,
        "ledger session-start markers"
    );
    assert!((report.flight.cost_usd_total.unwrap() - 0.5).abs() < 1e-9);
    let t = report.flight.tokens.unwrap();
    assert_eq!((t.input, t.output), (150, 15));

    // The render carries the §6 under-count label on the aggregate total.
    let md = render_markdown(&report);
    assert!(md.contains("excludes fix-session spend"), "{md}");
}

#[test]
fn render_grounds_verdict_gates_counts_and_timestamps() {
    let report = build_report(
        &synthetic_task(),
        &write_ledger(&[
            r#"{"event":"session-start"}"#,
            r#"{"ts":"2026-07-10T00:00:04Z","tool":"Bash","inputDigest":"git push --force","decision":"deny","ruleId":"harness-bash-deny"}"#,
        ])
        .1,
        TempDir::new().unwrap().path(),
    );
    let md = render_markdown(&report);

    assert!(md.contains("VERDICT: PASS"), "verdict line printed: {md}");
    assert!(
        md.contains("bun run coverage"),
        "each gate command printed: {md}"
    );
    assert!(md.contains("`folder-per-component`") || md.contains("folder-per-component"));
    assert!(md.contains("1 tool call evaluated"), "counts printed: {md}");
    assert!(md.contains(&report.generated_at), "mint timestamp printed");
    assert!(
        md.contains("2026-07-10T00:00:04Z"),
        "per-event ts printed: {md}"
    );
    // The GitHub variant carries the house footer.
    let gh = render_for_github(&report);
    assert!(gh.contains("_Posted from Nightcore._"), "{gh}");
    assert!(gh.starts_with("### 🌙 Nightcore — Trust report"));
}

#[test]
fn hostile_digest_is_neutralized_into_one_safe_code_span() {
    // A crafted digest with a backtick, a ``` fence, control chars, and a newline
    // must render as a SINGLE inline code span whose fence out-lengths any internal
    // backtick run — so nothing breaks out (clone the sanitize_minted_title posture).
    let hostile = "evil`\n```\u{1b}[31m rm -rf /```";
    let span = code_span(hostile);

    assert!(!span.contains('\n'), "no newline survives: {span:?}");
    assert!(
        !span.contains('\u{1b}'),
        "control chars are stripped: {span:?}"
    );
    // The delimiter run is strictly longer than the longest internal backtick run,
    // so the content can never close the span early. The fences are ASCII backticks,
    // so slicing at their byte offsets is UTF-8-safe.
    let lead = span.chars().take_while(|&c| c == '`').count();
    let trail = span.chars().rev().take_while(|&c| c == '`').count();
    assert_eq!(lead, trail, "symmetric fence: {span:?}");
    assert!(
        lead >= 2,
        "a backtick-bearing digest forces a longer fence: {span:?}"
    );
    let inner = span[lead..span.len() - trail].trim();
    assert!(
        longest_backtick_run(inner) < lead,
        "inner backtick runs must be shorter than the fence: {span:?}"
    );

    // Rendered inside a report, the hostile file digest can't break the section:
    // it stays confined to its own single bullet line (no injected newline splits
    // it across lines).
    let mut task = synthetic_task();
    task.structure_lock_result = None;
    let mut report = build_report(
        &task,
        Path::new("/no/ledger"),
        TempDir::new().unwrap().path(),
    );
    report.flight.files_touched = vec![hostile.to_string()];
    report.flight.files_touched_count = 1;
    let md = render_markdown(&report);
    let digest_lines: Vec<&str> = md.lines().filter(|l| l.contains("rm -rf")).collect();
    assert_eq!(
        digest_lines.len(),
        1,
        "the hostile digest stays on one bullet line: {md}"
    );
    assert!(
        digest_lines[0].trim_start().starts_with("- `"),
        "the digest bullet is code-fenced: {:?}",
        digest_lines[0]
    );
}

#[test]
fn quarantine_seam_defaults_empty_and_round_trips() {
    // Clone the serde-additive round-trip idiom (store/task/model.rs): a report
    // serialized WITHOUT the quarantine key deserializes with an empty list, so a
    // future writer joins with no shape migration.
    let report = build_report(
        &synthetic_task(),
        Path::new("/no/ledger"),
        TempDir::new().unwrap().path(),
    );
    let mut value = serde_json::to_value(&report).expect("serialize");
    assert_eq!(
        value["quarantine"],
        serde_json::json!([]),
        "v1 serializes an empty quarantine list"
    );

    // Drop the key entirely: `#[serde(default)]` supplies `[]` on deserialize.
    value.as_object_mut().unwrap().remove("quarantine");
    let back: TrustReport = serde_json::from_value(value).expect("deserialize without quarantine");
    assert!(back.quarantine.is_empty());
    assert_eq!(back.task_id, report.task_id, "the rest round-trips");
    assert_eq!(back.pr_number, Some(7));
}

#[test]
fn iso8601_utc_formats_a_known_instant() {
    // 1_700_000_000_000 ms = 2023-11-14T22:13:20Z (a checkable anchor).
    assert_eq!(iso8601_utc(1_700_000_000_000), "2023-11-14T22:13:20Z");
    // The unix epoch itself.
    assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
}

#[test]
fn code_span_fences_plain_and_backtick_content() {
    // Plain content uses a single-backtick span.
    assert_eq!(code_span("src/main.rs"), "`src/main.rs`");
    // Content that IS a backtick gets padded + a longer fence.
    let span = code_span("`");
    assert!(span.starts_with("`` ") && span.ends_with(" ``"), "{span}");
    // Empty/whitespace content falls back (never an empty span).
    assert_eq!(code_span("   "), "`(empty)`");
}
