//! Test-integrity anti-gaming sweep (production-harness catalog #2): a zero-cost,
//! ALWAYS-ON detector that scans a worktree build's committed diff for the classic
//! ways an agent games a green build instead of earning it — focusing/skipping
//! tests, sprinkling suppressions, tampering with the gate config under
//! `.nightcore/`, or gutting assertions out of existing tests. Built-in for
//! worktree Build tasks: unlike the manifest-driven structure-lock checks, no
//! `.nightcore/harness.json` entry arms it, because the thing it guards is the
//! gate machinery itself.
//!
//! On findings it appends ONE Failed [`StructureLockCheck`] (name/kind
//! `anti-gaming`) whose `output` lists the exact evidence, so a failure rides the
//! SAME bounded auto-fix / park machinery as every other structure-lock failure —
//! `fix_instruction` hands the agent the list of edits to undo. Zero findings
//! append NOTHING (a silent pass), mirroring how absent config appends no checks.
//!
//! Safety posture (a gate must not fail on its own plumbing):
//!   - the detectors are PURE functions over the diff text, unit-tested without git;
//!   - the git plumbing (base → merge-base → diff) is infrastructure — when any of
//!     it fails (unresolvable base, detached fallback that doesn't exist, git
//!     error) we WARN and skip the whole sweep, never failing the gate;
//!   - `@ts-expect-error` is deliberately NOT flagged: it is the sanctioned,
//!     self-expiring suppression form — flagging it would push agents back to
//!     `@ts-ignore`.

use std::path::Path;

use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};

/// The name AND kind of the appended check — a built-in, so the two coincide
/// (manifest checks carry a user name + a kind vocabulary; this has neither).
const CHECK_NAME: &str = "anti-gaming";

/// Cap on rendered evidence lines: enough for the auto-fix agent to act on, small
/// enough that a pathological diff can't balloon the persisted task JSON.
const MAX_LISTED_FINDINGS: usize = 40;

/// Focus/skip patterns flagged in ADDED lines of TEST files only. Each ends in a
/// non-identifier char, so only a leading boundary check is needed (`xit(` must
/// not fire inside `exit(`).
const FOCUS_SKIP_PATTERNS: &[&str] = &[
    ".only(",
    ".skip(",
    "xit(",
    "xdescribe(",
    "test.todo(",
    "it.todo(",
];

/// One piece of evidence: the file, a human-readable description of the matched
/// pattern, and the new-file line number when the hunk header made it cheap.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Finding {
    file: String,
    pattern: String,
    line: Option<u32>,
}

impl Finding {
    fn render(&self) -> String {
        match self.line {
            Some(n) => format!("{}:{} — {}", self.file, n, self.pattern),
            None => format!("{} — {}", self.file, self.pattern),
        }
    }
}

/// Run the sweep over the build's committed diff (`merge-base(base, HEAD)..HEAD`
/// in the review worktree, base resolved from the PROJECT root's HEAD) and append
/// a Failed `anti-gaming` check when it finds evidence. Infrastructure failures
/// (no merge-base, git error) WARN and skip — the sweep never fails the gate on
/// its own plumbing, only on what it actually saw in the diff.
pub fn append_anti_gaming_check(
    result: &mut StructureLockResult,
    review_dir: &Path,
    project_root: &Path,
) {
    let base = crate::worktree::base_branch(project_root);
    let Some(merge_base) = git_stdout(review_dir, &["merge-base", &base, "HEAD"]) else {
        tracing::warn!(target: "nightcore::anti_gaming", base = %base, dir = %review_dir.display(), "could not resolve merge-base; skipping anti-gaming sweep");
        return;
    };
    let range = format!("{merge_base}..HEAD");
    let Some(diff) = git_stdout(review_dir, &["diff", "--no-color", &range]) else {
        tracing::warn!(target: "nightcore::anti_gaming", range = %range, dir = %review_dir.display(), "git diff failed; skipping anti-gaming sweep");
        return;
    };

    let findings = detect_findings(&diff);
    if findings.is_empty() {
        tracing::debug!(target: "nightcore::anti_gaming", "anti-gaming sweep clean; nothing appended");
        return;
    }
    // Finding COUNT only to the log — the evidence body (which quotes diff content)
    // ships in the UI payload, never to the tracing sink.
    tracing::warn!(target: "nightcore::anti_gaming", findings = findings.len(), "anti-gaming sweep found suspicious changes; failing the gate");
    result.checks.push(StructureLockCheck {
        name: CHECK_NAME.to_string(),
        kind: CHECK_NAME.to_string(),
        command: format!("git diff {range}"),
        status: StepStatus::Failed,
        exit_code: None,
        output: Some(render_evidence(&findings)),
    });
    result.passed = false;
    if result.failed_check.is_none() {
        result.failed_check = Some(CHECK_NAME.to_string());
    }
}

// ─── Pure detectors (no git, no I/O) ────────────────────────────────────────────

/// Per-file assertion tally feeding the gutting detector.
struct FileTally {
    file: String,
    is_test: bool,
    deleted: bool,
    removed_assertions: u32,
    added_assertions: u32,
}

/// Scan a unified diff for gaming evidence, in ADDED lines only (except the
/// gutting detector, which by definition weighs removals against additions):
///  1. focus/skip patterns in test files,
///  2. new `@ts-ignore` / `eslint-disable` suppressions in ANY file,
///  3. any hunk touching a path under `.nightcore/` (gate-config tampering via a
///     route the runtime workspace hook didn't see),
///  4. assertion gutting: a changed (not deleted) test file that removes
///     `expect(`/`assert` lines and adds none.
fn detect_findings(diff: &str) -> Vec<Finding> {
    let mut findings = Vec::new();
    let mut tallies: Vec<FileTally> = Vec::new();
    let mut old_path: Option<String> = None;
    // Line number in the NEW file; 0 = unknown (no hunk header parsed yet).
    let mut new_line: u32 = 0;

    for line in diff.lines() {
        if let Some(rest) = line.strip_prefix("--- ") {
            old_path = parse_diff_path(rest, "a/");
            continue;
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            let new_path = parse_diff_path(rest, "b/");
            let deleted = new_path.is_none();
            // A deleted file is identified by its OLD path (the new side is /dev/null).
            let Some(file) = new_path.or_else(|| old_path.clone()) else {
                continue;
            };
            if file.starts_with(".nightcore/") {
                findings.push(Finding {
                    file: file.clone(),
                    pattern: "gate-config change under .nightcore/".to_string(),
                    line: None,
                });
            }
            tallies.push(FileTally {
                is_test: is_test_file(&file),
                file,
                deleted,
                removed_assertions: 0,
                added_assertions: 0,
            });
            new_line = 0;
            continue;
        }
        if line.starts_with("@@") {
            new_line = parse_hunk_new_start(line).unwrap_or(0);
            continue;
        }
        let Some(tally) = tallies.last_mut() else {
            continue; // preamble noise before the first file header
        };
        if let Some(content) = line.strip_prefix('+') {
            let at = (new_line > 0).then_some(new_line);
            if content.contains("@ts-ignore") {
                findings.push(Finding {
                    file: tally.file.clone(),
                    pattern: "new suppression: `@ts-ignore`".to_string(),
                    line: at,
                });
            }
            if contains_pattern(content, "eslint-disable") {
                findings.push(Finding {
                    file: tally.file.clone(),
                    pattern: "new suppression: `eslint-disable`".to_string(),
                    line: at,
                });
            }
            if tally.is_test {
                for pat in FOCUS_SKIP_PATTERNS {
                    if contains_pattern(content, pat) {
                        findings.push(Finding {
                            file: tally.file.clone(),
                            pattern: format!("focused/skipped test: `{pat}`"),
                            line: at,
                        });
                    }
                }
                if is_assertion(content) {
                    tally.added_assertions += 1;
                }
            }
            if new_line > 0 {
                new_line += 1;
            }
        } else if let Some(content) = line.strip_prefix('-') {
            if tally.is_test && is_assertion(content) {
                tally.removed_assertions += 1;
            }
        } else if new_line > 0 {
            // Context line: advances the new file. (`\ No newline` lines don't.)
            if !line.starts_with('\\') {
                new_line += 1;
            }
        }
    }

    for t in &tallies {
        if t.is_test && !t.deleted && t.removed_assertions > 0 && t.added_assertions == 0 {
            findings.push(Finding {
                file: t.file.clone(),
                pattern: format!(
                    "assertion gutting: removed {} `expect(`/`assert` line(s), added none",
                    t.removed_assertions
                ),
                line: None,
            });
        }
    }
    findings
}

/// Extract the repo-relative path from a `---`/`+++` header remainder
/// (`a/src/x.ts`, `b/src/x.ts`, or `/dev/null` ⇒ `None`).
fn parse_diff_path(rest: &str, prefix: &str) -> Option<String> {
    let rest = rest.trim_end();
    if rest == "/dev/null" {
        return None;
    }
    Some(rest.strip_prefix(prefix).unwrap_or(rest).to_string())
}

/// New-file start line from a hunk header (`@@ -12,5 +34,6 @@` ⇒ 34).
fn parse_hunk_new_start(line: &str) -> Option<u32> {
    let plus = line.split(' ').find(|t| t.starts_with('+'))?;
    plus[1..].split(',').next()?.parse().ok()
}

/// A test file by path convention: `*.test.*`, `*.spec.*`, or under `__tests__/`.
fn is_test_file(path: &str) -> bool {
    if path.contains("__tests__/") {
        return true;
    }
    let base = path.rsplit('/').next().unwrap_or(path);
    base.contains(".test.") || base.contains(".spec.")
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

/// `pattern` occurs in `line` with a left identifier boundary when the pattern
/// starts with an identifier char — so `xit(` doesn't fire inside `exit(` and
/// `eslint-disable` can't fire mid-identifier. No right boundary is needed: every
/// pattern we match ends in a non-identifier char (`(` or `-…e` followed by
/// checks that tolerate the `-line`/`-next-line` variants by design).
fn contains_pattern(line: &str, pattern: &str) -> bool {
    let bounded = pattern.chars().next().is_some_and(is_ident);
    let mut start = 0;
    while let Some(idx) = line[start..].find(pattern) {
        let abs = start + idx;
        if !bounded || !line[..abs].chars().next_back().is_some_and(is_ident) {
            return true;
        }
        start = abs + 1;
    }
    false
}

/// A line that carries a test assertion (for the gutting tally).
fn is_assertion(content: &str) -> bool {
    contains_pattern(content, "expect(") || contains_pattern(content, "assert")
}

/// Render the evidence list for the check `output` — this is what
/// `fix_instruction` hands the auto-fix agent, so it leads with the required
/// action and then names every file/pattern (capped, so a pathological diff
/// can't balloon the persisted task).
fn render_evidence(findings: &[Finding]) -> String {
    let mut out = format!(
        "Anti-gaming sweep: {} suspicious change(s) in this build's diff. Undo each \
         one and make the checks pass legitimately — do NOT focus/skip tests, add \
         `@ts-ignore`/`eslint-disable` suppressions, remove assertions, or edit \
         gate config under .nightcore/ (use `@ts-expect-error` where a suppression \
         is genuinely warranted):\n",
        findings.len()
    );
    for f in findings.iter().take(MAX_LISTED_FINDINGS) {
        out.push_str("- ");
        out.push_str(&f.render());
        out.push('\n');
    }
    if findings.len() > MAX_LISTED_FINDINGS {
        out.push_str(&format!(
            "… and {} more\n",
            findings.len() - MAX_LISTED_FINDINGS
        ));
    }
    out.trim_end().to_string()
}

// ─── Git plumbing ───────────────────────────────────────────────────────────────

/// Run git in `dir` for stdout, `None` on any failure (spawn or non-zero exit) —
/// the caller treats every `None` as "skip the sweep", never as a gate failure.
/// Routed through `platform::git_command` (env-scrubbed, the isolation posture
/// every git spawn in the crate shares).
fn git_stdout(dir: &Path, args: &[&str]) -> Option<String> {
    let out = crate::platform::git_command(dir).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            assert_eq!(detect_findings(&diff).len(), 1, "path {path:?} is a test file");
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
            &["-it.only('x', () => {})", " it.only('pre-existing', () => {})"],
        );
        let findings = detect_findings(&diff);
        // The removed line still counts toward the gutting tally only if it is an
        // assertion — `.only(` is not — so nothing at all is flagged here.
        assert!(findings.is_empty(), "removed/context lines are not findings: {findings:?}");
    }

    #[test]
    fn suppressions_flagged_in_any_file_but_ts_expect_error_is_sanctioned() {
        let diff = diff_for("src/anything.rs", &["+// @ts-ignore"]);
        assert_eq!(detect_findings(&diff).len(), 1, "@ts-ignore flagged in any file");

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
            &["-  expect(add(1, 2)).toBe(3)", "+  expect(add(1, 2)).toStrictEqual(3)"],
        );
        assert!(detect_findings(&diff).is_empty(), "a rewrite is not gutting");

        // A DELETED test file is a scope decision the reviewer sees in the diff
        // anyway — the gutting detector targets stealth edits to surviving files.
        let deleted = "diff --git a/src/old.test.ts b/src/old.test.ts\n\
                       deleted file mode 100644\n\
                       --- a/src/old.test.ts\n\
                       +++ /dev/null\n\
                       @@ -1,1 +0,0 @@\n\
                       -expect(x).toBe(1)\n";
        assert!(detect_findings(deleted).is_empty(), "deleted files are exempt");

        // Assertion-looking removals outside test files are none of our business.
        let diff = diff_for("src/util.ts", &["-  assert(invariant)"]);
        assert!(detect_findings(&diff).is_empty(), "non-test files are exempt");
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
        assert!(evidence.contains("@ts-expect-error"), "names the sanctioned form");
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
        append_anti_gaming_check(&mut result, tmp.path(), tmp.path());
        assert!(result.passed, "infrastructure failure must not fail the gate");
        assert!(result.checks.is_empty(), "nothing appended on skip");
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
        append_anti_gaming_check(&mut clean, &wt, &repo);
        assert!(clean.passed && clean.checks.is_empty(), "clean diff appends nothing");

        // Gaming change: a focused test fails the gate with evidence.
        std::fs::write(
            wt.join("math.test.ts"),
            "it.only('x', () => { expect(add(1,1)).toBe(2) })\n",
        )
        .expect("write");
        assert!(run(&wt, &["commit", "-qam", "focus the suite"]));
        let mut gamed = StructureLockResult::empty_pass();
        append_anti_gaming_check(&mut gamed, &wt, &repo);
        assert!(!gamed.passed, "a focused test fails the gate");
        assert_eq!(gamed.failed_check.as_deref(), Some("anti-gaming"));
        let check = &gamed.checks[0];
        assert_eq!(check.kind, "anti-gaming");
        assert_eq!(check.status, StepStatus::Failed);
        assert!(check.command.starts_with("git diff "), "reproducible command");
        let output = check.output.as_deref().unwrap();
        assert!(output.contains("math.test.ts"), "evidence names the file: {output}");
        assert!(output.contains(".only("), "evidence names the pattern: {output}");
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
}
