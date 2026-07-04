//! The pure diff detectors — no git, no I/O — plus the [`Finding`] evidence type
//! they emit. Scans a unified diff's ADDED lines for focus/skip test patterns,
//! new suppressions, `.nightcore/` gate-config tampering, and assertion gutting.
//! Unit-tested without a git repo (the `sweep` entry owns the plumbing).

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
pub(super) struct Finding {
    pub(super) file: String,
    pub(super) pattern: String,
    pub(super) line: Option<u32>,
}

impl Finding {
    pub(super) fn render(&self) -> String {
        match self.line {
            Some(n) => format!("{}:{} — {}", self.file, n, self.pattern),
            None => format!("{} — {}", self.file, self.pattern),
        }
    }
}

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
pub(super) fn detect_findings(diff: &str) -> Vec<Finding> {
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

pub(super) fn is_ident(c: char) -> bool {
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
