//! Diff budget (production-harness catalog #5): a scope gate that parks an
//! oversized worktree build for HUMAN triage before the structure-lock gauntlet
//! or the paid reviewer ever see it. An out-of-budget diff is a scoping decision,
//! not a defect — an auto-fix agent could only "fix" it by deleting work — so a
//! breach NEVER routes into the auto-fix loop and never hard-fails: the task is
//! parked `WaitingApproval` with an error naming actuals vs budget (the wiring in
//! `verification::handlers` owns that transition; this module only measures).
//!
//! This is deliberately ANOTHER separate, small reader of `.nightcore/harness.json`
//! — the file already has several deliberately-separate consumers (the
//! structure-lock gauntlet reads only `checks`, the harness apply path writes
//! artifacts) — each touches only its own key with its own lenient posture, so a
//! malformed sibling section can never take down an unrelated gate. This one
//! reads only `policy.diffBudget`, and it reads it from the PROJECT root: the
//! `.nightcore/` dir is gitignored, so it does not exist in the review worktree.
//!
//! Absent file / absent key / malformed ⇒ no budget ⇒ skip (warn on malformed),
//! and any git plumbing failure likewise skips — infrastructure never parks a
//! task. The catalog's session flight-recorder ledger (scope accounting across
//! fix attempts of one run) is explicitly deferred; this gates a single build's
//! committed diff only.

use std::path::Path;

use serde::Deserialize;

/// The relative manifest path shared with the structure-lock gauntlet (each
/// consumer keeps its own constant on purpose — no coupling between readers).
const CONFIG_REL_PATH: &str = ".nightcore/harness.json";

/// The `policy.diffBudget` shape. Both limits optional; a budget with neither is
/// treated as unconfigured. Serde-additive: future keys must not break parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffBudget {
    #[serde(default)]
    max_changed_lines: Option<u64>,
    #[serde(default)]
    max_changed_files: Option<u64>,
}

/// The measured size of a build's committed diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct DiffMeasure {
    changed_lines: u64,
    changed_files: u64,
}

/// Evaluate the project's diff budget against the review worktree's committed
/// diff. `Some(message)` ⇒ breach (the caller parks the task with it);
/// `None` ⇒ no budget configured, within budget, or infrastructure failure
/// (warned, never parked). Worktree builds only — the caller gates on that.
pub fn evaluate(project_root: &Path, review_dir: &Path) -> Option<String> {
    let budget = load_budget(project_root)?;
    let base = crate::worktree::base_branch(project_root);
    let Some(merge_base) = git_stdout(review_dir, &["merge-base", &base, "HEAD"]) else {
        tracing::warn!(target: "nightcore::diff_budget", base = %base, dir = %review_dir.display(), "could not resolve merge-base; skipping diff budget");
        return None;
    };
    let range = format!("{merge_base}..HEAD");
    let Some(numstat) = git_stdout(review_dir, &["diff", "--numstat", "--no-renames", &range])
    else {
        tracing::warn!(target: "nightcore::diff_budget", range = %range, dir = %review_dir.display(), "git diff --numstat failed; skipping diff budget");
        return None;
    };
    let measure = parse_numstat_totals(&numstat);
    let breach = breach_message(&budget, &measure);
    if let Some(msg) = &breach {
        tracing::warn!(target: "nightcore::diff_budget", changed_lines = measure.changed_lines, changed_files = measure.changed_files, "diff budget exceeded: {msg}");
    }
    breach
}

/// Read `policy.diffBudget` from the PROJECT root's manifest. Every "no budget"
/// path returns `None`: absent file / absent key silently, malformed with a warn
/// (a user wrote something and it isn't being honored — they should know).
fn load_budget(project_root: &Path) -> Option<DiffBudget> {
    let raw = std::fs::read_to_string(project_root.join(CONFIG_REL_PATH)).ok()?;
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(target: "nightcore::diff_budget", error = %e, "malformed .nightcore/harness.json; skipping diff budget");
            return None;
        }
    };
    let budget = value.get("policy")?.get("diffBudget")?;
    match serde_json::from_value::<DiffBudget>(budget.clone()) {
        Ok(b) if b.max_changed_lines.is_some() || b.max_changed_files.is_some() => Some(b),
        Ok(_) => None, // a diffBudget with no limits is unconfigured, not zero
        Err(e) => {
            tracing::warn!(target: "nightcore::diff_budget", error = %e, "malformed policy.diffBudget; skipping diff budget");
            None
        }
    }
}

/// Sum `git diff --numstat` output into totals. Each row is one changed file;
/// binary rows (`-\t-\tpath`) contribute one file and zero lines. Pure.
fn parse_numstat_totals(numstat: &str) -> DiffMeasure {
    let mut measure = DiffMeasure::default();
    for line in numstat.lines() {
        let mut f = line.splitn(3, '\t');
        let add = f.next().unwrap_or("0").parse::<u64>().unwrap_or(0);
        let del = f.next().unwrap_or("0").parse::<u64>().unwrap_or(0);
        if f.next().filter(|p| !p.is_empty()).is_none() {
            continue; // malformed / blank row — not a file
        }
        measure.changed_lines += add + del;
        measure.changed_files += 1;
    }
    measure
}

/// Compose the park message for a breach, naming every exceeded limit with its
/// actual vs budget so the human can triage scope at a glance. `None` ⇒ within
/// budget. A limit is a maximum: equal-to-budget passes. Pure.
fn breach_message(budget: &DiffBudget, measure: &DiffMeasure) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(max) = budget.max_changed_lines {
        if measure.changed_lines > max {
            parts.push(format!(
                "{} changed lines (budget {max})",
                measure.changed_lines
            ));
        }
    }
    if let Some(max) = budget.max_changed_files {
        if measure.changed_files > max {
            parts.push(format!(
                "{} changed files (budget {max})",
                measure.changed_files
            ));
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "diff budget exceeded: {} — review scope before verifying",
        parts.join(", ")
    ))
}

/// Run git in `dir` for stdout, `None` on any failure — callers treat every
/// `None` as "skip the gate". Routed through the env-scrubbed
/// `platform::git_command` like every git spawn in the crate.
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

    fn project_with_manifest(body: &str) -> tempfile::TempDir {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let nc = tmp.path().join(".nightcore");
        std::fs::create_dir_all(&nc).expect("mkdir .nightcore");
        std::fs::write(nc.join("harness.json"), body).expect("write harness.json");
        tmp
    }

    #[test]
    fn no_budget_when_file_key_or_limits_are_absent() {
        // Absent file.
        let bare = tempfile::TempDir::new().expect("temp dir");
        assert!(load_budget(bare.path()).is_none(), "absent file ⇒ no budget");
        // Present file, no policy key (the gauntlet-only manifest shape).
        let tmp = project_with_manifest(r#"{ "checks": [] }"#);
        assert!(load_budget(tmp.path()).is_none(), "absent key ⇒ no budget");
        // policy present, diffBudget absent.
        let tmp = project_with_manifest(r#"{ "policy": {} }"#);
        assert!(load_budget(tmp.path()).is_none());
        // diffBudget present but empty: unconfigured, NOT a zero budget.
        let tmp = project_with_manifest(r#"{ "policy": { "diffBudget": {} } }"#);
        assert!(load_budget(tmp.path()).is_none(), "no limits ⇒ no budget");
    }

    #[test]
    fn malformed_manifest_or_budget_warns_and_skips() {
        let tmp = project_with_manifest("{ not json");
        assert!(load_budget(tmp.path()).is_none(), "malformed file ⇒ skip");
        let tmp = project_with_manifest(r#"{ "policy": { "diffBudget": { "maxChangedLines": "lots" } } }"#);
        assert!(load_budget(tmp.path()).is_none(), "malformed value ⇒ skip");
    }

    #[test]
    fn budget_parses_partial_and_full_limits() {
        let tmp = project_with_manifest(
            r#"{ "policy": { "diffBudget": { "maxChangedLines": 400 } } }"#,
        );
        let b = load_budget(tmp.path()).expect("lines-only budget");
        assert_eq!(b.max_changed_lines, Some(400));
        assert_eq!(b.max_changed_files, None);

        let tmp = project_with_manifest(
            r#"{ "policy": { "diffBudget": { "maxChangedLines": 400, "maxChangedFiles": 20 } },
                 "checks": [{ "name": "coexists", "kind": "lint-plugin" }] }"#,
        );
        let b = load_budget(tmp.path()).expect("full budget coexists with checks");
        assert_eq!(b.max_changed_lines, Some(400));
        assert_eq!(b.max_changed_files, Some(20));
    }

    #[test]
    fn numstat_totals_sum_lines_and_files_with_binary_rows() {
        let numstat = "10\t2\tsrc/a.ts\n0\t5\tsrc/b.ts\n-\t-\tassets/logo.png\n";
        let m = parse_numstat_totals(numstat);
        assert_eq!(m.changed_lines, 17, "adds + deletes across text rows");
        assert_eq!(m.changed_files, 3, "the binary row still counts as a file");
        assert_eq!(parse_numstat_totals(""), DiffMeasure::default());
        // Malformed rows (no path) don't count as files.
        assert_eq!(parse_numstat_totals("5\t5\n").changed_files, 0);
    }

    #[test]
    fn breach_message_names_actuals_vs_budget() {
        let budget = DiffBudget {
            max_changed_lines: Some(400),
            max_changed_files: Some(20),
        };
        // At the limit is within budget (a max, not a threshold).
        let at_limit = DiffMeasure { changed_lines: 400, changed_files: 20 };
        assert!(breach_message(&budget, &at_limit).is_none());

        let lines_over = DiffMeasure { changed_lines: 812, changed_files: 8 };
        let msg = breach_message(&budget, &lines_over).expect("breach");
        assert_eq!(
            msg,
            "diff budget exceeded: 812 changed lines (budget 400) — review scope before verifying"
        );

        let both_over = DiffMeasure { changed_lines: 812, changed_files: 27 };
        let msg = breach_message(&budget, &both_over).expect("breach");
        assert!(msg.contains("812 changed lines (budget 400)"), "{msg}");
        assert!(msg.contains("27 changed files (budget 20)"), "{msg}");
    }

    #[test]
    fn an_unset_limit_is_never_breached() {
        let files_only = DiffBudget {
            max_changed_lines: None,
            max_changed_files: Some(2),
        };
        let m = DiffMeasure { changed_lines: 9999, changed_files: 3 };
        let msg = breach_message(&files_only, &m).expect("files breach");
        assert!(
            !msg.contains("changed lines"),
            "the unset lines limit must not appear: {msg}"
        );
    }

    #[test]
    fn evaluate_skips_on_infrastructure_failure() {
        // A configured budget over a non-repo review dir: merge-base fails ⇒ skip
        // (warn), never a park message.
        let project = project_with_manifest(
            r#"{ "policy": { "diffBudget": { "maxChangedLines": 1 } } }"#,
        );
        let not_a_repo = tempfile::TempDir::new().expect("temp dir");
        assert!(
            evaluate(project.path(), not_a_repo.path()).is_none(),
            "infrastructure failure must not park"
        );
    }

    /// One real-git pass: a worktree branch whose committed diff exceeds the
    /// project-root budget yields the park message; raising the budget clears it.
    /// Skips when `git` is unavailable (worktree/tests.rs posture).
    #[test]
    fn evaluate_measures_a_real_worktree_diff() {
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
        std::fs::write(wt.join("big.ts"), "line\n".repeat(10)).expect("write");
        assert!(run(&wt, &["add", "."]) && run(&wt, &["commit", "-q", "-m", "ten lines"]));

        // Budget of 4 lines: the 10-line commit breaches.
        let nc = repo.join(".nightcore");
        std::fs::create_dir_all(&nc).expect("mkdir");
        std::fs::write(
            nc.join("harness.json"),
            r#"{ "policy": { "diffBudget": { "maxChangedLines": 4 } } }"#,
        )
        .expect("write manifest");
        let msg = evaluate(&repo, &wt).expect("breach");
        assert!(msg.contains("10 changed lines (budget 4)"), "{msg}");

        // A roomier budget passes the same diff.
        std::fs::write(
            nc.join("harness.json"),
            r#"{ "policy": { "diffBudget": { "maxChangedLines": 100, "maxChangedFiles": 5 } } }"#,
        )
        .expect("write manifest");
        assert!(evaluate(&repo, &wt).is_none(), "within budget ⇒ no park");
    }

    /// Real git repo with one commit, or `None` when git is unavailable.
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
        // Mirror production: `.nightcore/` is gitignored, so the budget manifest
        // written by the tests never shows up in the measured diff.
        std::fs::write(path.join(".gitignore"), ".nightcore/\nwt/\n").ok()?;
        std::fs::write(path.join("README.md"), "hi").ok()?;
        run(&["add", "."]);
        if !run(&["commit", "-q", "-m", "init"]) {
            return None;
        }
        Some((tmp, path))
    }
}
