//! Unit + real-git integration tests for the anti-gaming sweep, kept together so
//! the diff detectors, the ledger detector, and the end-to-end `append` fold can
//! share the `diff_for` / `temp_repo` fixtures.

use std::path::Path;

use super::detect::{detect_findings, Finding};
use super::ledger::{contains_no_verify, detect_ledger_findings};
use super::report::{render_evidence, MAX_LISTED_FINDINGS};
use super::sweep::append_anti_gaming_check;
use crate::store::types::{StepStatus, StructureLockResult};

/// A minimal synthetic unified diff: one file, one hunk, the given body lines
/// (caller supplies the `+`/`-`/` ` prefixes).
fn diff_for(path: &str, body: &[&str]) -> String {
    let mut d = format!(
        "diff --git a/{path} b/{path}\nindex 111..222 100644\n--- a/{path}\n+++ b/{path}\n@@ -1,3 +10,4 @@\n"
    );
    for line in body {
        d.push_str(line);
        d.push('\n');
    }
    d
}

#[test]
fn focused_and_skipped_tests_flagged_in_test_files_only() {
    for pat in [
        "it.only('x', () => {})",
        "describe.skip('y', () => {})",
        "xit('z', () => {})",
        "xdescribe('w', () => {})",
        "test.todo('later')",
        "it.todo('later')",
    ] {
        let diff = diff_for("src/foo.test.ts", &[&format!("+{pat}")]);
        assert_eq!(
            detect_findings(&diff).len(),
            1,
            "must flag {pat:?} in a test file"
        );
        // The same added line in a NON-test file is not a focus/skip finding.
        let diff = diff_for("src/foo.ts", &[&format!("+{pat}")]);
        assert!(
            detect_findings(&diff).is_empty(),
            "must not flag {pat:?} outside test files"
        );
    }
    // All three test-path conventions are recognized.
    for path in ["a/b.test.tsx", "a/b.spec.ts", "src/__tests__/b.ts"] {
        let diff = diff_for(path, &["+it.only('x', () => {})"]);
        assert_eq!(
            detect_findings(&diff).len(),
            1,
            "path {path:?} is a test file"
        );
    }
}

#[test]
fn xit_does_not_fire_inside_exit() {
    // The identifier-boundary guard: `exit(1)` contains the substring `xit(`.
    let diff = diff_for("src/foo.test.ts", &["+process.exit(1)"]);
    assert!(detect_findings(&diff).is_empty(), "exit( is not xit(");
}

#[test]
fn only_added_lines_are_scanned_for_focus_patterns() {
    // REMOVING a `.only(` is the fix, not the crime; context lines are ambient.
    let diff = diff_for(
        "src/foo.test.ts",
        &[
            "-it.only('x', () => {})",
            " it.only('pre-existing', () => {})",
        ],
    );
    let findings = detect_findings(&diff);
    // The removed line still counts toward the gutting tally only if it is an
    // assertion — `.only(` is not — so nothing at all is flagged here.
    assert!(
        findings.is_empty(),
        "removed/context lines are not findings: {findings:?}"
    );
}

#[test]
fn suppressions_flagged_in_any_file_but_ts_expect_error_is_sanctioned() {
    let diff = diff_for("src/anything.rs", &["+// @ts-ignore"]);
    assert_eq!(
        detect_findings(&diff).len(),
        1,
        "@ts-ignore flagged in any file"
    );

    for variant in [
        "+/* eslint-disable */",
        "+// eslint-disable-next-line no-console",
        "+// eslint-disable-line",
    ] {
        let diff = diff_for("src/app.ts", &[variant]);
        assert_eq!(detect_findings(&diff).len(), 1, "must flag {variant:?}");
    }

    // The sanctioned form must NOT be flagged.
    let diff = diff_for("src/app.ts", &["+// @ts-expect-error upstream types lag"]);
    assert!(
        detect_findings(&diff).is_empty(),
        "@ts-expect-error is the sanctioned suppression"
    );
}

#[test]
fn nightcore_paths_are_flagged_including_deletions() {
    // Modifying gate config through the diff (a route the runtime workspace
    // hook never saw) is tampering, whatever the content.
    let diff = diff_for(".nightcore/harness.json", &["+{ \"checks\": [] }"]);
    let findings = detect_findings(&diff);
    assert_eq!(findings.len(), 1);
    assert!(findings[0].pattern.contains(".nightcore/"), "{findings:?}");

    // A DELETED gate file only has an old path (`+++ /dev/null`) — still flagged.
    let diff = "diff --git a/.nightcore/harness.json b/.nightcore/harness.json\n\
                deleted file mode 100644\n\
                --- a/.nightcore/harness.json\n\
                +++ /dev/null\n\
                @@ -1,1 +0,0 @@\n\
                -{ \"checks\": [] }\n";
    let findings = detect_findings(diff);
    assert_eq!(findings.len(), 1, "deleting gate config is tampering too");
    assert_eq!(findings[0].file, ".nightcore/harness.json");
}

#[test]
fn assertion_gutting_flags_removed_without_added() {
    let diff = diff_for(
        "src/math.test.ts",
        &[
            "-  expect(add(1, 2)).toBe(3)",
            "-  assert.equal(mul(2, 2), 4)",
            "+  // covered elsewhere",
        ],
    );
    let findings = detect_findings(&diff);
    assert_eq!(findings.len(), 1, "{findings:?}");
    assert!(findings[0].pattern.contains("removed 2"), "{findings:?}");
}

#[test]
fn assertion_gutting_not_flagged_when_rewritten_deleted_or_non_test() {
    // Removed AND added assertions ⇒ a rewrite, not gutting.
    let diff = diff_for(
        "src/math.test.ts",
        &[
            "-  expect(add(1, 2)).toBe(3)",
            "+  expect(add(1, 2)).toStrictEqual(3)",
        ],
    );
    assert!(
        detect_findings(&diff).is_empty(),
        "a rewrite is not gutting"
    );

    // A DELETED test file is a scope decision the reviewer sees in the diff
    // anyway — the gutting detector targets stealth edits to surviving files.
    let deleted = "diff --git a/src/old.test.ts b/src/old.test.ts\n\
                   deleted file mode 100644\n\
                   --- a/src/old.test.ts\n\
                   +++ /dev/null\n\
                   @@ -1,1 +0,0 @@\n\
                   -expect(x).toBe(1)\n";
    assert!(
        detect_findings(deleted).is_empty(),
        "deleted files are exempt"
    );

    // Assertion-looking removals outside test files are none of our business.
    let diff = diff_for("src/util.ts", &["-  assert(invariant)"]);
    assert!(
        detect_findings(&diff).is_empty(),
        "non-test files are exempt"
    );
}

#[test]
fn line_numbers_are_tracked_from_hunk_headers() {
    // Hunk starts at new-file line 10; a context line advances it, so the
    // added line lands on 11.
    let diff = diff_for(
        "src/foo.test.ts",
        &[" const x = 1;", "+it.only('x', () => {})"],
    );
    let findings = detect_findings(&diff);
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].line, Some(11), "{findings:?}");
    assert_eq!(
        findings[0].render(),
        "src/foo.test.ts:11 — focused/skipped test: `.only(`"
    );
}

#[test]
fn multiple_findings_across_files_all_reported() {
    let mut diff = diff_for("src/a.test.ts", &["+it.only('a', () => {})"]);
    diff.push_str(&diff_for("src/b.ts", &["+// @ts-ignore"]));
    let findings = detect_findings(&diff);
    assert_eq!(findings.len(), 2);
    let files: Vec<&str> = findings.iter().map(|f| f.file.as_str()).collect();
    assert_eq!(files, vec!["src/a.test.ts", "src/b.ts"]);
}

#[test]
fn evidence_lists_every_finding_and_caps_the_tail() {
    let findings: Vec<Finding> = (0..MAX_LISTED_FINDINGS + 3)
        .map(|i| Finding {
            file: format!("src/f{i}.test.ts"),
            pattern: "focused/skipped test: `.only(`".to_string(),
            line: Some(1),
        })
        .collect();
    let evidence = render_evidence(&findings);
    assert!(evidence.contains("src/f0.test.ts:1"));
    assert!(evidence.contains("… and 3 more"), "{evidence}");
    // The instruction the auto-fix agent acts on leads the output.
    assert!(evidence.starts_with("Anti-gaming sweep:"));
    assert!(
        evidence.contains("@ts-expect-error"),
        "names the sanctioned form"
    );
}

#[test]
fn empty_diff_yields_no_findings() {
    assert!(detect_findings("").is_empty());
}

#[test]
fn append_skips_on_infrastructure_failure() {
    // A non-repo review dir can't resolve a merge-base: the sweep must skip
    // (WARN), never fail the gate on its own plumbing.
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let mut result = StructureLockResult::empty_pass();
    append_anti_gaming_check(&mut result, tmp.path(), tmp.path(), None);
    assert!(
        result.passed,
        "infrastructure failure must not fail the gate"
    );
    assert!(result.checks.is_empty(), "nothing appended on skip");
}

// ─── Ledger (Bash-history) detector ────────────────────────────────────────

/// Parse fixture NDJSON lines into ledger records (the reader is lenient, so
/// building through it also pins the wire shape the engine writes).
fn ledger_records(lines: &[&str]) -> Vec<crate::store::ledger::LedgerRecord> {
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let path = tmp.path().join("task.ndjson");
    std::fs::write(&path, lines.join("\n")).expect("write ledger");
    crate::store::ledger::read_records(&path)
}

#[test]
fn ledger_detector_flags_allowed_no_verify_bash_only() {
    let records = ledger_records(&[
        r#"{"ts":"2026-07-01T00:00:00Z","event":"session-start","sessionId":1}"#,
        // The crime: an ALLOWED Bash record carrying --no-verify.
        r#"{"tool":"Bash","inputDigest":"git commit -m x --no-verify","decision":"allow"}"#,
        // A DENIED one is exempt (the rail held).
        r#"{"tool":"Bash","inputDigest":"git commit --no-verify","decision":"deny","ruleId":"harness-bash-deny"}"#,
        // Innocent allowed Bash.
        r#"{"tool":"Bash","inputDigest":"bun test","decision":"allow"}"#,
        // Non-Bash records never carry a command line.
        r#"{"tool":"Write","inputDigest":"--no-verify","decision":"allow"}"#,
        r#"{"event":"session-end","sessionId":1}"#,
    ]);
    let findings = detect_ledger_findings(&records);
    assert_eq!(findings.len(), 1, "{findings:?}");
    assert!(
        findings[0].file.contains("git commit -m x --no-verify"),
        "{findings:?}"
    );
    assert!(findings[0].pattern.contains("hook bypass"), "{findings:?}");
}

#[test]
fn no_verify_matches_on_identifier_boundaries_only() {
    assert!(contains_no_verify("git commit --no-verify"));
    assert!(contains_no_verify("git commit --no-verify -m x"));
    assert!(contains_no_verify("git push --no-verify"));
    // The DISTINCT git flag --no-verify-signatures must not fire.
    assert!(!contains_no_verify(
        "git merge --no-verify-signatures branch"
    ));
    // Mid-identifier / longer-dash-run occurrences must not fire.
    assert!(!contains_no_verify("echo x--no-verify"));
    assert!(!contains_no_verify("run ---no-verify"));
    assert!(!contains_no_verify("git commit --no-verifyx"));
    // Not present at all.
    assert!(!contains_no_verify("git commit -m 'no verify needed'"));
}

#[test]
fn empty_or_missing_ledger_contributes_nothing() {
    assert!(detect_ledger_findings(&[]).is_empty());
    // A missing file reads as zero records (silent skip), so the appended
    // sweep sees only the diff half.
    let records =
        crate::store::ledger::read_records(std::path::Path::new("/no/such/ledger.ndjson"));
    assert!(detect_ledger_findings(&records).is_empty());
}

/// End-to-end fold: a clean committed diff + a dirty ledger still fails the
/// gate, with the Bash-history evidence in the SAME `anti-gaming` check the
/// diff detectors use. Skips when `git` is unavailable.
#[test]
fn ledger_findings_fold_into_the_anti_gaming_check() {
    use std::process::Command;
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let run = |dir: &Path, args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    assert!(run(&repo, &["worktree", "add", "wt", "-b", "feature"]));
    let wt = repo.join("wt");
    std::fs::write(wt.join("honest.ts"), "export const x = 1;\n").expect("write");
    assert!(run(&wt, &["add", "."]) && run(&wt, &["commit", "-q", "-m", "honest work"]));

    let ledger = repo.join("task.ndjson");
    std::fs::write(
        &ledger,
        r#"{"tool":"Bash","inputDigest":"git commit -q -m x --no-verify","decision":"allow"}"#,
    )
    .expect("write ledger");

    let mut result = StructureLockResult::empty_pass();
    append_anti_gaming_check(&mut result, &wt, &repo, Some(&ledger));
    assert!(
        !result.passed,
        "a ledger hit fails the gate even with a clean diff"
    );
    assert_eq!(result.failed_check.as_deref(), Some("anti-gaming"));
    let output = result.checks[0].output.as_deref().unwrap();
    assert!(
        output.contains("--no-verify"),
        "evidence names the flag: {output}"
    );
    assert!(output.contains("hook bypass"), "{output}");

    // The same sweep with NO ledger stays clean (the diff half is innocent).
    let mut clean = StructureLockResult::empty_pass();
    append_anti_gaming_check(&mut clean, &wt, &repo, None);
    assert!(clean.passed && clean.checks.is_empty());
}

/// One real-git integration pass: a worktree branch whose first commit is
/// innocent appends nothing; a second commit adding `.only(` fails the gate
/// with evidence. Skips when `git` is unavailable (worktree/tests.rs posture).
#[test]
fn sweep_over_a_real_worktree_diff() {
    use std::process::Command;
    let Some((_tmp, repo)) = temp_repo() else {
        return;
    };
    let run = |dir: &Path, args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    assert!(run(&repo, &["worktree", "add", "wt", "-b", "feature"]));
    let wt = repo.join("wt");

    // Innocent change: nothing appended (the silent pass).
    std::fs::write(wt.join("math.test.ts"), "expect(add(1,1)).toBe(2)\n").expect("write");
    assert!(run(&wt, &["add", "."]) && run(&wt, &["commit", "-q", "-m", "honest work"]));
    let mut clean = StructureLockResult::empty_pass();
    append_anti_gaming_check(&mut clean, &wt, &repo, None);
    assert!(
        clean.passed && clean.checks.is_empty(),
        "clean diff appends nothing"
    );

    // Gaming change: a focused test fails the gate with evidence.
    std::fs::write(
        wt.join("math.test.ts"),
        "it.only('x', () => { expect(add(1,1)).toBe(2) })\n",
    )
    .expect("write");
    assert!(run(&wt, &["commit", "-qam", "focus the suite"]));
    let mut gamed = StructureLockResult::empty_pass();
    append_anti_gaming_check(&mut gamed, &wt, &repo, None);
    assert!(!gamed.passed, "a focused test fails the gate");
    assert_eq!(gamed.failed_check.as_deref(), Some("anti-gaming"));
    let check = &gamed.checks[0];
    assert_eq!(check.kind, "anti-gaming");
    assert_eq!(check.status, StepStatus::Failed);
    assert!(
        check.command.starts_with("git diff "),
        "reproducible command"
    );
    let output = check.output.as_deref().unwrap();
    assert!(
        output.contains("math.test.ts"),
        "evidence names the file: {output}"
    );
    assert!(
        output.contains(".only("),
        "evidence names the pattern: {output}"
    );
}

/// Real git repo with one commit, or `None` when git is unavailable
/// (mirrors `worktree/tests.rs::temp_repo`).
fn temp_repo() -> Option<(tempfile::TempDir, std::path::PathBuf)> {
    use std::process::Command;
    let tmp = tempfile::TempDir::new().expect("temp dir");
    let path = tmp.path().to_path_buf();
    let run = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(&path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    if !run(&["init", "-q"]) {
        return None;
    }
    run(&["config", "user.email", "t@t.t"]);
    run(&["config", "user.name", "t"]);
    std::fs::write(path.join("README.md"), "hi").ok()?;
    run(&["add", "."]);
    if !run(&["commit", "-q", "-m", "init"]) {
        return None;
    }
    Some((tmp, path))
}
