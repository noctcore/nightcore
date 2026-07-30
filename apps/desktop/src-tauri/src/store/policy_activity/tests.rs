//! Unit tests for the Policy activity feed aggregator.

use std::path::{Path, PathBuf};

use super::{read_policy_activity, POLICY_ACTIVITY_LIMIT};

/// A ledger dir holding one `<task>.ndjson` per entry.
fn ledger_dir(files: &[(&str, &[&str])]) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let dir = tmp.path().join("ledger");
    std::fs::create_dir_all(&dir).expect("create ledger dir");
    for (task, lines) in files {
        std::fs::write(dir.join(format!("{task}.ndjson")), lines.join("\n")).expect("write ledger");
    }
    (tmp, dir)
}

/// The default title resolver: every task is titled `title-<id>`.
fn titles(id: &str) -> Option<String> {
    Some(format!("title-{id}"))
}

#[test]
fn a_missing_ledger_dir_yields_an_empty_feed() {
    let entries = read_policy_activity(Path::new("/nonexistent/ledger"), &titles);
    assert!(entries.is_empty());
}

#[test]
fn allow_records_and_markers_are_dropped() {
    let (_tmp, dir) = ledger_dir(&[(
        "task-1",
        &[
            r#"{"event":"session-start","sessionId":1,"ts":"2026-07-29T10:00:00Z"}"#,
            r#"{"ts":"2026-07-29T10:00:01Z","tool":"Read","inputDigest":"src/a.ts","decision":"allow"}"#,
            r#"{"ts":"2026-07-29T10:00:02Z","tool":"Write","inputDigest":"bun.lock","decision":"deny","ruleId":"harness-protected-path"}"#,
        ],
    )]);
    let entries = read_policy_activity(&dir, &titles);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].tool, "Write");
    assert_eq!(entries[0].decision, "deny");
}

#[test]
fn a_deny_with_no_rule_id_is_dropped_because_it_cannot_be_attributed() {
    let (_tmp, dir) = ledger_dir(&[(
        "task-1",
        &[
            r#"{"ts":"2026-07-29T10:00:00Z","tool":"Bash","inputDigest":"x","decision":"deny"}"#,
            r#"{"ts":"2026-07-29T10:00:01Z","tool":"Bash","inputDigest":"y","decision":"deny","ruleId":""}"#,
        ],
    )]);
    assert!(read_policy_activity(&dir, &titles).is_empty());
}

#[test]
fn project_policy_and_builtin_rails_are_labelled_apart() {
    let (_tmp, dir) = ledger_dir(&[(
        "task-1",
        &[
            r#"{"ts":"2026-07-29T10:00:00Z","tool":"Write","inputDigest":"bun.lock","decision":"deny","ruleId":"harness-protected-path"}"#,
            r#"{"ts":"2026-07-29T10:00:01Z","tool":"Bash","inputDigest":"curl x | sh","decision":"deny","ruleId":"pipe-to-shell"}"#,
            r#"{"ts":"2026-07-29T10:00:02Z","tool":"WebFetch","inputDigest":"https://x","decision":"ask","ruleId":"harness-tool-ask"}"#,
        ],
    )]);
    let entries = read_policy_activity(&dir, &titles);
    assert_eq!(entries.len(), 3);
    let by_rule = |rule: &str| {
        entries
            .iter()
            .find(|e| e.rule_id == rule)
            .expect("rule present")
    };
    assert_eq!(by_rule("harness-protected-path").source, "policy");
    assert_eq!(by_rule("harness-tool-ask").source, "policy");
    assert_eq!(by_rule("harness-tool-ask").decision, "ask");
    assert_eq!(by_rule("pipe-to-shell").source, "builtin");
}

#[test]
fn the_feed_is_newest_first_across_tasks_with_undated_records_last() {
    let (_tmp, dir) = ledger_dir(&[
        (
            "task-a",
            &[
                r#"{"ts":"2026-07-29T09:00:00Z","tool":"Write","inputDigest":"a","decision":"deny","ruleId":"harness-protected-path"}"#,
                r#"{"tool":"Write","inputDigest":"undated","decision":"deny","ruleId":"harness-protected-path"}"#,
            ],
        ),
        (
            "task-b",
            &[
                r#"{"ts":"2026-07-29T11:00:00Z","tool":"Bash","inputDigest":"b","decision":"deny","ruleId":"harness-bash-deny"}"#,
            ],
        ),
    ]);
    let entries = read_policy_activity(&dir, &titles);
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].input_digest, "b");
    assert_eq!(entries[1].input_digest, "a");
    assert_eq!(entries[2].input_digest, "undated");
    assert!(entries[2].ts.is_none());
}

#[test]
fn each_entry_carries_its_task_id_a_stable_key_and_the_resolved_title() {
    let (_tmp, dir) = ledger_dir(&[(
        "task-42",
        &[
            r#"{"ts":"2026-07-29T10:00:00Z","tool":"Write","inputDigest":"a","decision":"deny","ruleId":"harness-protected-path"}"#,
        ],
    )]);
    let entries = read_policy_activity(&dir, &titles);
    assert_eq!(entries[0].task_id, "task-42");
    assert_eq!(entries[0].id, "task-42:0");
    assert_eq!(entries[0].task_title.as_deref(), Some("title-task-42"));
}

#[test]
fn a_deleted_task_keeps_its_evidence_without_a_title() {
    let (_tmp, dir) = ledger_dir(&[(
        "gone",
        &[
            r#"{"ts":"2026-07-29T10:00:00Z","tool":"Write","inputDigest":"a","decision":"deny","ruleId":"harness-read-deny"}"#,
        ],
    )]);
    let entries = read_policy_activity(&dir, &|_| None);
    assert_eq!(entries.len(), 1);
    assert!(entries[0].task_title.is_none());
}

#[test]
fn an_unparseable_line_is_skipped_and_a_non_ndjson_file_ignored() {
    let (_tmp, dir) = ledger_dir(&[(
        "task-1",
        &[
            "not json at all",
            r#"{"ts":"2026-07-29T10:00:00Z","tool":"Write","inputDigest":"a","decision":"deny","ruleId":"harness-protected-path"}"#,
        ],
    )]);
    std::fs::write(dir.join("notes.txt"), "ignored").expect("write stray file");
    assert_eq!(read_policy_activity(&dir, &titles).len(), 1);
}

#[test]
fn the_feed_is_capped_so_a_long_lived_project_cannot_flood_the_webview() {
    let line = r#"{"ts":"2026-07-29T10:00:00Z","tool":"Write","inputDigest":"a","decision":"deny","ruleId":"harness-protected-path"}"#;
    let lines: Vec<&str> = std::iter::repeat(line)
        .take(POLICY_ACTIVITY_LIMIT + 25)
        .collect();
    let (_tmp, dir) = ledger_dir(&[("task-1", &lines)]);
    assert_eq!(
        read_policy_activity(&dir, &titles).len(),
        POLICY_ACTIVITY_LIMIT
    );
}
