//! Unit coverage for the per-project governance journal (#399): the append-only
//! write path, its concurrency + integrity properties, the lenient reader, and the
//! sanitize/redact gate every persisted field passes through.

use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::*;

/// A temp project root; the dir lives as long as the guard.
fn project() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().expect("temp dir");
    let root = tmp.path().to_path_buf();
    (tmp, root)
}

/// Every non-empty line of the journal, raw.
fn raw_lines(root: &Path) -> Vec<String> {
    std::fs::read_to_string(journal_path(root))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect()
}

#[test]
fn journal_lives_beside_the_per_task_recorder_files() {
    assert_eq!(
        journal_path(Path::new("/proj")),
        PathBuf::from("/proj/.nightcore/ledger/project.ndjson"),
        "the journal is the reserved `project.ndjson` in the ledger dir"
    );
}

#[test]
fn a_missing_journal_reads_empty_rather_than_erroring() {
    let read = read_journal(Path::new("/no/such/project"));
    assert!(read.events.is_empty());
    assert_eq!(read.corrupt_lines, 0);
}

/// The PERSISTED shape is pinned: camelCase keys, one newline-terminated line per
/// event, and no `id` on disk (the reader synthesizes it from the line index).
#[test]
fn a_record_persists_as_one_camel_case_ndjson_line() {
    let (_tmp, root) = project();
    append(
        &root,
        KIND_QUARANTINE,
        "quarantined 1 path",
        &["docs/notes.md".to_string()],
    );

    let raw = std::fs::read_to_string(journal_path(&root)).expect("journal written");
    assert!(raw.ends_with('\n'), "every record is newline-terminated");
    let value: serde_json::Value = serde_json::from_str(raw.trim()).expect("one JSON object");
    assert_eq!(value["kind"], KIND_QUARANTINE);
    assert_eq!(value["summary"], "quarantined 1 path");
    assert_eq!(value["detail"][0], "docs/notes.md");
    assert!(
        value["ts"].as_str().is_some_and(|t| t.ends_with('Z')),
        "ts is ISO-8601 UTC: {value}"
    );
    assert!(
        value.get("id").is_none(),
        "`id` is a read-side synthesis, never persisted: {value}"
    );
}

/// Append-only: a second event never rewrites or truncates the first.
#[test]
fn appending_preserves_every_earlier_record_in_order() {
    let (_tmp, root) = project();
    append(&root, KIND_ARM, "armed `lint`", &[]);
    append(&root, KIND_DISARM, "disarmed `lint`", &[]);
    append(&root, KIND_RATCHET, "ratchet baseline snapshotted", &[]);

    let read = read_journal(&root);
    assert_eq!(read.events.len(), 3);
    assert_eq!(
        read.events
            .iter()
            .map(|e| e.kind.as_str())
            .collect::<Vec<_>>(),
        vec![KIND_ARM, KIND_DISARM, KIND_RATCHET],
        "records keep their on-disk (chronological) order"
    );
    assert_eq!(read.events[0].summary, "armed `lint`");
    // Ids are the line indices — stable because nothing is ever inserted or removed.
    assert_eq!(
        read.events
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        vec!["0", "1", "2"]
    );
}

/// The interleave property (module header, properties 1-3): concurrent writers must
/// each land a COMPLETE line — never a torn or interleaved one, never a lost record.
#[test]
fn concurrent_appends_never_interleave_or_drop_a_record() {
    let (_tmp, root) = project();
    const WRITERS: usize = 8;
    const PER_WRITER: usize = 25;

    std::thread::scope(|scope| {
        for writer in 0..WRITERS {
            let root = root.clone();
            scope.spawn(move || {
                for n in 0..PER_WRITER {
                    append(
                        &root,
                        KIND_POLICY_SAVE,
                        &format!("writer {writer} record {n}"),
                        &[format!("detail-{writer}-{n}")],
                    );
                }
            });
        }
    });

    let read = read_journal(&root);
    assert_eq!(
        read.events.len(),
        WRITERS * PER_WRITER,
        "every concurrent append landed exactly once"
    );
    assert_eq!(
        read.corrupt_lines, 0,
        "no line was torn by a concurrent writer"
    );
    // Every record is individually well-formed (a torn line would have parsed as
    // corrupt above, but pin the payload too).
    for event in &read.events {
        assert_eq!(event.kind, KIND_POLICY_SAVE);
        assert!(event.summary.starts_with("writer "), "{}", event.summary);
        assert_eq!(event.detail.len(), 1);
    }
}

/// A corrupt line is skipped AND COUNTED — never a panic, never a lost sibling.
#[test]
fn corrupt_lines_are_skipped_and_counted_without_losing_siblings() {
    let (_tmp, root) = project();
    append(&root, KIND_ARM, "armed `lint`", &[]);

    // Simulate a torn/garbage tail (a crash mid-write on a filesystem without our
    // guarantees, or a hand-edit).
    let path = journal_path(&root);
    let mut raw = std::fs::read_to_string(&path).expect("journal");
    raw.push_str("{\"ts\":\"2026-07-29T00:00:00Z\",\"kind\":\"ar\n");
    raw.push_str("not json at all\n");
    raw.push('\n'); // a blank line is not corruption
    raw.push_str("{\"ts\":\"2026-07-29T00:00:01Z\",\"kind\":\"disarm\",\"summary\":\"ok\"}\n");
    std::fs::write(&path, raw).expect("rewrite fixture");

    let read = read_journal(&root);
    assert_eq!(read.corrupt_lines, 2, "both unparseable lines are counted");
    assert_eq!(
        read.events.len(),
        2,
        "the good records on either side survive"
    );
    assert_eq!(read.events[0].kind, KIND_ARM);
    assert_eq!(read.events[1].kind, KIND_DISARM);
}

/// Serde-additive at the VOCABULARY level: a kind this build does not know still
/// loads verbatim rather than being dropped, and absent optional fields default.
#[test]
fn an_unknown_kind_and_a_minimal_record_still_load() {
    let (_tmp, root) = project();
    let path = journal_path(&root);
    std::fs::create_dir_all(path.parent().unwrap()).expect("ledger dir");
    std::fs::write(
        &path,
        "{\"ts\":\"2027-01-01T00:00:00Z\",\"kind\":\"future-kind\"}\n",
    )
    .expect("seed");

    let read = read_journal(&root);
    assert_eq!(read.corrupt_lines, 0);
    let event = &read.events[0];
    assert_eq!(
        event.kind, "future-kind",
        "an unknown kind is kept verbatim"
    );
    assert_eq!(event.summary, "", "an absent summary defaults");
    assert!(event.detail.is_empty(), "absent detail defaults to empty");
}

/// Nothing credential-shaped may ever reach the journal, and the caller is not
/// trusted to have redacted.
#[test]
fn credential_shaped_values_are_redacted_before_they_are_persisted() {
    let (_tmp, root) = project();
    let token = "ghp_ABCdef0123456789klmn";
    append(
        &root,
        KIND_POLICY_SAVE,
        &format!("policy saved with token={token}"),
        &[format!("Authorization: Bearer {token}")],
    );

    let raw = raw_lines(&root).remove(0);
    assert!(
        !raw.contains(token),
        "a token leaked into the journal: {raw}"
    );
    assert!(raw.contains("<redacted>"), "{raw}");
}

/// A record must never break the ONE-LINE-per-event invariant, whatever the caller
/// passes — an embedded newline would otherwise forge a second record.
#[test]
fn control_characters_cannot_forge_a_second_record() {
    let (_tmp, root) = project();
    append(
        &root,
        KIND_ARM,
        "armed\n{\"kind\":\"disarm\"}\nfake",
        &["a\tb".to_string()],
    );

    assert_eq!(raw_lines(&root).len(), 1, "still exactly one physical line");
    let read = read_journal(&root);
    assert_eq!(read.events.len(), 1);
    assert!(
        !read.events[0].summary.contains('\n'),
        "newlines are collapsed to spaces"
    );
    assert_eq!(read.events[0].detail[0], "a b");
}

/// Fields are capped so a record stays far under the size where a single write
/// could be split (module header, property 2).
#[test]
fn oversized_fields_are_capped() {
    let (_tmp, root) = project();
    // Realistic prose/paths, not one opaque run — a long unbroken token would be
    // redacted (defence in depth) before the cap could be observed.
    let long_summary = "saved rule ".repeat(MAX_SUMMARY_CHARS);
    let details: Vec<String> = (0..MAX_DETAIL_ITEMS * 2)
        .map(|i| {
            format!(
                "src/{}/file-{i}.ts",
                "segment/".repeat(MAX_DETAIL_CHARS / 4)
            )
        })
        .collect();
    append(&root, KIND_QUARANTINE, &long_summary, &details);

    let read = read_journal(&root);
    let event = &read.events[0];
    assert_eq!(
        event.summary.chars().count(),
        MAX_SUMMARY_CHARS + 1,
        "the summary is truncated (plus the ellipsis marker)"
    );
    assert_eq!(
        event.detail.len(),
        MAX_DETAIL_ITEMS,
        "the detail list is capped"
    );
    for item in &event.detail {
        assert!(item.chars().count() <= MAX_DETAIL_CHARS + 1, "{item}");
    }
    assert!(
        raw_lines(&root)[0].len() < 4096,
        "a capped record stays well under one page"
    );
}

/// Empty detail items are dropped rather than persisted as noise.
#[test]
fn blank_detail_items_are_dropped() {
    let (_tmp, root) = project();
    append(
        &root,
        KIND_DISARM,
        "disarmed",
        &["   ".to_string(), "lint".to_string(), String::new()],
    );
    assert_eq!(read_journal(&root).events[0].detail, vec!["lint"]);
}

/// The journal must not show up in the user's `git status` (nor make a worktree
/// read as dirty): the ledger dir carries a self-ignoring `.gitignore`.
#[test]
fn the_ledger_dir_gets_a_self_ignoring_gitignore() {
    let (_tmp, root) = project();
    append(&root, KIND_ARM, "armed `lint`", &[]);

    let ignore = crate::store::ledger::ledger_dir(&root).join(".gitignore");
    assert_eq!(
        std::fs::read_to_string(&ignore).expect("ignore file written"),
        "*\n",
        "`*` also matches the .gitignore itself, so the guard is invisible too"
    );

    // Idempotent: a user-customized ignore file is never clobbered.
    std::fs::write(&ignore, "# mine\n*\n").expect("customize");
    append(&root, KIND_ARM, "armed `arch`", &[]);
    assert_eq!(
        std::fs::read_to_string(&ignore).expect("ignore file"),
        "# mine\n*\n"
    );
}

/// The journal records governance decisions; like `settings.json` it is owner-only.
#[cfg(unix)]
#[test]
fn the_journal_is_created_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let (_tmp, root) = project();
    append(&root, KIND_RATCHET, "ratchet baseline snapshotted", &[]);
    let mode = std::fs::metadata(journal_path(&root))
        .expect("journal")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "got {mode:o}");
}

/// An unwritable ledger location must not panic or propagate — journaling is
/// best-effort so it can never fail the governance action it records.
#[test]
fn an_unwritable_journal_location_is_swallowed() {
    let (_tmp, root) = project();
    // A FILE where the ledger dir must be ⇒ `create_dir_all` fails.
    std::fs::create_dir_all(root.join(".nightcore")).expect("nightcore dir");
    std::fs::write(root.join(".nightcore/ledger"), b"not a dir").expect("blocker");

    append(&root, KIND_POLICY_SAVE, "policy saved", &[]);

    let read = read_journal(&root);
    assert!(
        read.events.is_empty(),
        "nothing was recorded, nothing panicked"
    );
}
