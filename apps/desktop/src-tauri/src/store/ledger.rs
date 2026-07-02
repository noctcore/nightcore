//! Session flight-recorder ledger (production-harness catalog #5) — the Rust
//! reader side and the single owner of the on-disk path formula.
//!
//! The ENGINE is the only writer: it appends one NDJSON record per PreToolUse
//! gate evaluation (plus `session-start`/`session-end` markers) to
//! `<project_root>/.nightcore/ledger/<task_id>.ndjson` — the path this module
//! computes and the core carries on `start-session` (`ledgerPath`). The project
//! root is the SAME root the harness policy resolves from, NOT the worktree cwd,
//! so build/reviewer/fix sessions of one task share one file.
//!
//! Readers are deterministic gates ([`crate::workflow::anti_gaming`] and the
//! blocked-by-policy park gate in `verification::handlers`), so parsing is
//! lenient and NEVER an error: a missing file yields no records (a run predating
//! the recorder, or no project root), and an unparseable line is skipped — a
//! gate must not fail on its evidence plumbing (the diff-budget posture).

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The ledger directory under the project root. `.nightcore/` is gitignored, so
/// ledgers never appear in any diff the gates measure.
const LEDGER_DIR_REL: &str = ".nightcore/ledger";

/// The engine-side rule id for a protected-path write denial
/// (`HARNESS_PROTECTED_PATH_RULE_ID` in `packages/engine/src/policy/harness-policy.ts`).
pub const PROTECTED_PATH_RULE_ID: &str = "harness-protected-path";

/// The shared prefix of every harness-policy rule id the engine emits
/// (`harness-protected-path`, `harness-bash-deny`, `harness-read-deny`,
/// `harness-tool-deny`) — distinct from the built-in destructive/confinement
/// rule ids, which the policy gates don't own.
const HARNESS_RULE_PREFIX: &str = "harness-";

/// The per-task ledger path. Must stay in lockstep with what the core sends on
/// `start-session` — both call THIS function (single owner of the formula).
pub fn ledger_path(project_root: &Path, task_id: &str) -> PathBuf {
    project_root
        .join(LEDGER_DIR_REL)
        .join(format!("{task_id}.ndjson"))
}

/// One ledger line, parsed leniently: tool records carry `tool`/`inputDigest`/
/// `decision` (+ `ruleId` on deny); marker lines carry `event` instead. Every
/// field optional so an unknown future shape still parses (serde-additive).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRecord {
    /// Marker discriminator: `session-start` / `session-end` / `truncated`.
    /// Parsed so marker lines round-trip (and a future reader can segment the
    /// file by session), but no production detector reads it yet.
    #[serde(default)]
    #[allow(dead_code)]
    pub event: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    /// First ~200 chars of the most relevant input field (Bash command line,
    /// target path). A digest, never the full tool input.
    #[serde(default)]
    pub input_digest: Option<String>,
    /// `allow` | `deny` | `ask` — the PreToolUse gate's decision (`ask` =
    /// escalated to an interactive approval by the policy's `askTools` tier).
    #[serde(default)]
    pub decision: Option<String>,
    /// The matched rule id on deny (e.g. `harness-protected-path`).
    #[serde(default)]
    pub rule_id: Option<String>,
}

impl LedgerRecord {
    /// A denial issued by the project's harness policy (any `harness-*` rule) —
    /// as opposed to the built-in destructive/confinement denials.
    pub fn is_harness_policy_denial(&self) -> bool {
        self.decision.as_deref() == Some("deny")
            && self
                .rule_id
                .as_deref()
                .is_some_and(|id| id.starts_with(HARNESS_RULE_PREFIX))
    }

    /// A harness-policy denial of a WRITE to a protected path specifically.
    pub fn is_protected_path_denial(&self) -> bool {
        self.decision.as_deref() == Some("deny")
            && self.rule_id.as_deref() == Some(PROTECTED_PATH_RULE_ID)
    }
}

/// Read every parseable record. Missing/unreadable file ⇒ empty (silent skip —
/// the pre-recorder shape); an unparseable LINE is skipped, its siblings kept.
pub fn read_records(path: &Path) -> Vec<LedgerRecord> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            serde_json::from_str::<LedgerRecord>(line).ok()
        })
        .collect()
}

/// The blocked-by-policy park message, or `None` when the ledger shows no
/// protected-path denials (or is missing/unparseable — infrastructure never
/// parks a task). Evidence-first: leads with the count, then the denied paths
/// (deduped, capped) so a human can triage the rail at a glance. Any OTHER
/// harness-policy denials (bash/read/tool) ride along as a count.
pub fn blocked_by_policy_message(ledger: &Path) -> Option<String> {
    let records = read_records(ledger);
    let protected: Vec<&LedgerRecord> = records
        .iter()
        .filter(|r| r.is_protected_path_denial())
        .collect();
    if protected.is_empty() {
        return None;
    }

    // Denied paths, deduped in first-seen order, capped for the task error.
    const MAX_LISTED_PATHS: usize = 5;
    let mut paths: Vec<&str> = Vec::new();
    for record in &protected {
        if let Some(digest) = record.input_digest.as_deref() {
            if !digest.is_empty() && !paths.contains(&digest) {
                paths.push(digest);
            }
        }
    }
    let mut listed = paths
        .iter()
        .take(MAX_LISTED_PATHS)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    if paths.len() > MAX_LISTED_PATHS {
        listed.push_str(&format!(" (+{} more)", paths.len() - MAX_LISTED_PATHS));
    }
    if listed.is_empty() {
        listed = "(paths unrecorded)".to_string();
    }

    let other = records
        .iter()
        .filter(|r| r.is_harness_policy_denial() && !r.is_protected_path_denial())
        .count();
    let other_note = if other > 0 {
        format!(" (+{other} other policy denial(s))")
    } else {
        String::new()
    };

    Some(format!(
        "blocked by harness policy: {} denied write(s) to protected paths — {listed}{other_note}. \
         The agent could not complete this work within the project's rails; review the task's \
         scope or the protectedPaths rules in .nightcore/harness.json before retrying.",
        protected.len()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_ledger(lines: &[&str]) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let path = tmp.path().join("task.ndjson");
        std::fs::write(&path, lines.join("\n")).expect("write ledger");
        (tmp, path)
    }

    #[test]
    fn ledger_path_is_rooted_at_the_project_manifest_dir() {
        let p = ledger_path(Path::new("/proj"), "task-1");
        assert_eq!(p, PathBuf::from("/proj/.nightcore/ledger/task-1.ndjson"));
    }

    #[test]
    fn missing_file_and_unparseable_lines_are_skipped_silently() {
        assert!(read_records(Path::new("/no/such/ledger.ndjson")).is_empty());

        let (_tmp, path) = write_ledger(&[
            r#"{"ts":"2026-07-01T00:00:00Z","event":"session-start","sessionId":1}"#,
            "not json at all",
            "",
            r#"{"ts":"2026-07-01T00:00:01Z","tool":"Bash","inputDigest":"bun test","decision":"allow"}"#,
        ]);
        let records = read_records(&path);
        assert_eq!(records.len(), 2, "the bad line is dropped, siblings kept");
        assert_eq!(records[0].event.as_deref(), Some("session-start"));
        assert_eq!(records[1].tool.as_deref(), Some("Bash"));
        assert_eq!(records[1].decision.as_deref(), Some("allow"));
    }

    #[test]
    fn denial_classifiers_split_harness_rules_from_builtins() {
        let parse = |s: &str| serde_json::from_str::<LedgerRecord>(s).unwrap();
        let protected = parse(
            r#"{"tool":"Write","inputDigest":"migrations/0001.sql","decision":"deny","ruleId":"harness-protected-path"}"#,
        );
        assert!(protected.is_harness_policy_denial());
        assert!(protected.is_protected_path_denial());

        let bash = parse(
            r#"{"tool":"Bash","inputDigest":"git push --force","decision":"deny","ruleId":"harness-bash-deny"}"#,
        );
        assert!(bash.is_harness_policy_denial());
        assert!(!bash.is_protected_path_denial());

        // Built-in (destructive/confinement) denials are NOT harness-policy denials.
        let builtin = parse(
            r#"{"tool":"Bash","inputDigest":"rm -rf /","decision":"deny","ruleId":"destructive-rm"}"#,
        );
        assert!(!builtin.is_harness_policy_denial());

        // An ALLOWED record never classifies as a denial, whatever it carries.
        let allowed = parse(
            r#"{"tool":"Write","inputDigest":"migrations/x.sql","decision":"allow","ruleId":"harness-protected-path"}"#,
        );
        assert!(!allowed.is_harness_policy_denial());
    }

    #[test]
    fn park_message_names_count_and_deduped_paths() {
        let (_tmp, path) = write_ledger(&[
            r#"{"event":"session-start","sessionId":1}"#,
            r#"{"tool":"Write","inputDigest":"migrations/0001.sql","decision":"deny","ruleId":"harness-protected-path"}"#,
            r#"{"tool":"Edit","inputDigest":"migrations/0001.sql","decision":"deny","ruleId":"harness-protected-path"}"#,
            r#"{"tool":"Write","inputDigest":"bun.lock","decision":"deny","ruleId":"harness-protected-path"}"#,
            r#"{"tool":"Bash","inputDigest":"git commit --no-verify","decision":"deny","ruleId":"harness-bash-deny"}"#,
            r#"{"event":"session-end","sessionId":1}"#,
        ]);
        let msg = blocked_by_policy_message(&path).expect("denials present");
        assert!(
            msg.starts_with("blocked by harness policy: 3 denied write(s)"),
            "{msg}"
        );
        assert!(msg.contains("migrations/0001.sql"), "{msg}");
        assert!(msg.contains("bun.lock"), "{msg}");
        assert_eq!(
            msg.matches("migrations/0001.sql").count(),
            1,
            "paths dedupe"
        );
        assert!(msg.contains("+1 other policy denial"), "{msg}");
    }

    #[test]
    fn park_message_is_none_without_protected_path_denials() {
        // Missing file: infrastructure never parks.
        assert!(blocked_by_policy_message(Path::new("/no/such/ledger.ndjson")).is_none());

        // Allowed records + a NON-protected-path denial: still no park (the park
        // gate is specifically about denied writes to protected paths).
        let (_tmp, path) = write_ledger(&[
            r#"{"tool":"Bash","inputDigest":"bun test","decision":"allow"}"#,
            r#"{"tool":"Bash","inputDigest":"git commit --no-verify","decision":"deny","ruleId":"harness-bash-deny"}"#,
        ]);
        assert!(blocked_by_policy_message(&path).is_none());
    }

    #[test]
    fn park_message_caps_the_listed_paths() {
        let mut lines: Vec<String> = Vec::new();
        for i in 0..8 {
            lines.push(format!(
                r#"{{"tool":"Write","inputDigest":"migrations/{i:04}.sql","decision":"deny","ruleId":"harness-protected-path"}}"#
            ));
        }
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let (_tmp, path) = write_ledger(&refs);
        let msg = blocked_by_policy_message(&path).expect("denials present");
        assert!(msg.contains("8 denied write(s)"), "{msg}");
        assert!(msg.contains("(+3 more)"), "{msg}");
    }
}
