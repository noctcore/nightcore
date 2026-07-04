//! Agent-contract instruction-budget gate (production-harness catalog #8, gate
//! tier): the synthesis playbook compiles `CLAUDE.md`/`AGENTS.md` against a
//! ~150-line instruction budget at GENERATION time — this check re-verifies it
//! at BUILD time, so an agent that balloons a contract file mid-task (the classic
//! "append my whole plan to AGENTS.md" failure) is caught deterministically
//! before the paid reviewer.
//!
//! Scope mirrors the anti-gaming sweep: worktree builds only (the committed
//! `merge-base..HEAD` range is what tells us THIS run touched a contract), and
//! only contracts the diff actually touched are gated — a pre-existing overweight
//! contract must not fail unrelated tasks. Touched and within budget appends a
//! visible Passed check (like the held ratchet); untouched appends nothing.
//! Infrastructure failures (no merge-base, git error) WARN and skip — the gate
//! never fails on its own plumbing.

use std::path::Path;

use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};

/// The name AND kind of the appended check — a built-in like `anti-gaming`.
const CHECK_NAME: &str = "agent-contract-budget";

/// Basenames gated as agent contracts, at any directory depth (nested
/// `AGENTS.md` files are contracts too — the parity lint already treats them so).
const CONTRACT_BASENAMES: &[&str] = &["CLAUDE.md", "AGENTS.md"];

/// The playbook compiles contracts toward ~150 lines; the gate allows headroom so
/// a legitimate edit near the target doesn't flap. Only a touched contract that
/// clearly outgrew the budget fails.
const MAX_CONTRACT_LINES: usize = 200;

/// Gate the build's touched agent contracts against the line budget and append
/// the verdict to the structure-lock result (see the module doc for scope).
pub fn append_contract_budget_check(
    result: &mut StructureLockResult,
    review_dir: &Path,
    project_root: &Path,
) {
    let base = crate::worktree::base_branch(project_root);
    let Some(merge_base) = git_stdout(review_dir, &["merge-base", &base, "HEAD"]) else {
        tracing::warn!(target: "nightcore::contract_budget", base = %base, dir = %review_dir.display(), "could not resolve merge-base; skipping contract-budget gate");
        return;
    };
    let range = format!("{merge_base}..HEAD");
    let Some(names) = git_stdout(review_dir, &["diff", "--no-color", "--name-only", &range]) else {
        tracing::warn!(target: "nightcore::contract_budget", range = %range, dir = %review_dir.display(), "git diff failed; skipping contract-budget gate");
        return;
    };

    let touched: Vec<&str> = names.lines().filter(|p| is_contract_path(p)).collect();
    if touched.is_empty() {
        return;
    }

    let (within, over) = measure(review_dir, &touched);
    if over.is_empty() {
        result.checks.push(StructureLockCheck {
            name: CHECK_NAME.to_string(),
            kind: CHECK_NAME.to_string(),
            command: format!("git diff --name-only {range}"),
            status: StepStatus::Passed,
            exit_code: Some(0),
            output: Some(format!(
                "touched agent contracts within the {MAX_CONTRACT_LINES}-line budget: {}",
                within.join(", ")
            )),
        });
        return;
    }

    tracing::warn!(target: "nightcore::contract_budget", over = over.len(), "agent contract outgrew the instruction budget; failing the gate");
    result.checks.push(StructureLockCheck {
        name: CHECK_NAME.to_string(),
        kind: CHECK_NAME.to_string(),
        command: format!("git diff --name-only {range}"),
        status: StepStatus::Failed,
        exit_code: None,
        output: Some(format!(
            "agent contract(s) outgrew the {MAX_CONTRACT_LINES}-line instruction budget \
(compiled contracts stay ~150 lines — imperative, project-specific rules only):\n{}\n\
Restructure the overflow into linked satellite docs instead of growing the contract.",
            over.join("\n")
        )),
    });
    result.passed = false;
    if result.failed_check.is_none() {
        result.failed_check = Some(CHECK_NAME.to_string());
    }
}

/// True for a diff path whose basename is an agent contract.
fn is_contract_path(path: &str) -> bool {
    let basename = path.rsplit('/').next().unwrap_or(path);
    CONTRACT_BASENAMES.contains(&basename)
}

/// Split touched contracts into within-budget (`path — N lines`) and over-budget
/// (`path — N lines (budget M)`) evidence lines. A path that no longer exists in
/// the review dir (deleted contract) is fine — deletion cannot exceed a budget.
fn measure(review_dir: &Path, touched: &[&str]) -> (Vec<String>, Vec<String>) {
    let mut within = Vec::new();
    let mut over = Vec::new();
    for path in touched {
        let Ok(text) = std::fs::read_to_string(review_dir.join(path)) else {
            continue;
        };
        let lines = text.lines().count();
        if lines > MAX_CONTRACT_LINES {
            over.push(format!(
                "{path} — {lines} lines (budget {MAX_CONTRACT_LINES})"
            ));
        } else {
            within.push(format!("{path} — {lines} lines"));
        }
    }
    (within, over)
}

/// Run git in `dir` for stdout, `None` on any failure — callers treat every
/// `None` as "skip the gate". Routed through the env-scrubbed
/// `platform::git_command` like every git spawn in the crate (its siblings
/// `diff_budget::git_stdout` / `anti_gaming::sweep::git_stdout`), so a poisoned
/// env or repo-local `.git/config` can't turn this gate's git ops into host RCE.
fn git_stdout(dir: &Path, args: &[&str]) -> Option<String> {
    let out = crate::platform::git_command(dir).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn contract_basenames_match_at_any_depth() {
        assert!(is_contract_path("CLAUDE.md"));
        assert!(is_contract_path("AGENTS.md"));
        assert!(is_contract_path("packages/engine/AGENTS.md"));
        assert!(!is_contract_path("docs/CLAUDE.md.bak"));
        assert!(!is_contract_path("src/agents.md"));
        assert!(!is_contract_path("README.md"));
    }

    /// Regression: `git_stdout` must route through the env-scrubbed,
    /// config-neutralized `platform::git_command` (it once spawned git directly,
    /// diverging from its diff_budget/sweep siblings). A repo carrying a hostile
    /// `.git/config` with `core.fsmonitor=<cmd>` must NOT get that program spawned
    /// when the gate reads git output — while a legit query still returns.
    #[test]
    #[cfg(unix)]
    fn git_stdout_neutralizes_hostile_fsmonitor_config() {
        let tmp = TempDir::new().expect("tempdir");
        let root = tmp.path();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(root)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .expect("git runs");
            assert!(out.status.success(), "git {args:?} failed");
        };
        git(&["init", "-b", "main"]);
        std::fs::write(root.join("f.txt"), "x\n").expect("write");
        git(&["add", "-A"]);
        git(&["commit", "-m", "base"]);

        let pwned = root.join("PWNED");
        use std::io::Write;
        let mut cfg = std::fs::OpenOptions::new()
            .append(true)
            .open(root.join(".git/config"))
            .expect("open .git/config");
        writeln!(cfg, "[core]\n\tfsmonitor = \"touch {}\"", pwned.display()).expect("write config");
        drop(cfg);

        // First-party path still works: ls-files returns the tracked file.
        let out = git_stdout(root, &["ls-files"]).expect("ls-files returns");
        assert!(out.contains("f.txt"));
        // Vector blocked: the planted fsmonitor command never ran.
        assert!(
            !pwned.exists(),
            "hostile core.fsmonitor was executed — git_stdout bypassed git_command"
        );
    }

    #[test]
    fn measure_splits_within_and_over_and_skips_deleted() {
        let tmp = TempDir::new().expect("tempdir");
        std::fs::write(tmp.path().join("CLAUDE.md"), "rule\n".repeat(120)).expect("write");
        std::fs::write(
            tmp.path().join("AGENTS.md"),
            "rule\n".repeat(MAX_CONTRACT_LINES + 30),
        )
        .expect("write");
        let (within, over) = measure(tmp.path(), &["CLAUDE.md", "AGENTS.md", "deleted/AGENTS.md"]);
        assert_eq!(within, vec!["CLAUDE.md — 120 lines".to_string()]);
        assert_eq!(
            over,
            vec![format!(
                "AGENTS.md — {} lines (budget {MAX_CONTRACT_LINES})",
                MAX_CONTRACT_LINES + 30
            )]
        );
    }

    #[test]
    fn boundary_line_count_is_within_budget() {
        let tmp = TempDir::new().expect("tempdir");
        std::fs::write(
            tmp.path().join("AGENTS.md"),
            "rule\n".repeat(MAX_CONTRACT_LINES),
        )
        .expect("write");
        let (within, over) = measure(tmp.path(), &["AGENTS.md"]);
        assert_eq!(within.len(), 1, "exactly at budget passes");
        assert!(over.is_empty());
    }

    /// Full plumbing against a real git fixture mirroring production shape: the
    /// PROJECT root stays on `main` while the review dir is a linked WORKTREE on
    /// a task branch — grow AGENTS.md past the budget there → the appended check
    /// fails with evidence; an untouched contract appends nothing.
    #[test]
    fn gate_fails_only_when_a_touched_contract_is_over_budget() {
        let tmp = TempDir::new().expect("tempdir");
        let root = tmp.path().join("project");
        std::fs::create_dir_all(&root).expect("mkdir project");
        let git = |dir: &Path, args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .expect("git runs");
            assert!(out.status.success(), "git {args:?}: {:?}", out);
        };
        git(&root, &["init", "-b", "main"]);
        std::fs::write(root.join("AGENTS.md"), "rule\n".repeat(10)).expect("write");
        std::fs::write(root.join("lib.rs"), "fn main() {}\n").expect("write");
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-m", "base"]);
        let review = tmp.path().join("wt");
        git(
            &root,
            &[
                "worktree",
                "add",
                review.to_str().expect("utf8"),
                "-b",
                "task",
            ],
        );

        // An untouched contract appends nothing, even with other file changes.
        std::fs::write(review.join("lib.rs"), "fn main() { let _ = 1; }\n").expect("write");
        git(&review, &["add", "-A"]);
        git(&review, &["commit", "-m", "code only"]);
        let mut result = StructureLockResult {
            passed: true,
            checks: Vec::new(),
            failed_check: None,
        };
        append_contract_budget_check(&mut result, &review, &root);
        assert!(result.passed);
        assert!(result.checks.is_empty(), "untouched contract gates nothing");

        // Growing the contract past the budget fails the gate with evidence.
        std::fs::write(
            review.join("AGENTS.md"),
            "rule\n".repeat(MAX_CONTRACT_LINES + 1),
        )
        .expect("write");
        git(&review, &["add", "-A"]);
        git(&review, &["commit", "-m", "balloon the contract"]);
        let mut result = StructureLockResult {
            passed: true,
            checks: Vec::new(),
            failed_check: None,
        };
        append_contract_budget_check(&mut result, &review, &root);
        assert!(!result.passed);
        assert_eq!(result.failed_check.as_deref(), Some(CHECK_NAME));
        let output = result.checks[0].output.as_deref().expect("evidence");
        assert!(output.contains("AGENTS.md"));
        assert!(output.contains("satellite docs"));

        // Trimming it back within budget appends a visible Passed check.
        std::fs::write(review.join("AGENTS.md"), "rule\n".repeat(60)).expect("write");
        git(&review, &["add", "-A"]);
        git(&review, &["commit", "-m", "trim the contract"]);
        let mut result = StructureLockResult {
            passed: true,
            checks: Vec::new(),
            failed_check: None,
        };
        append_contract_budget_check(&mut result, &review, &root);
        assert!(result.passed);
        assert_eq!(result.checks.len(), 1);
        assert!(matches!(result.checks[0].status, StepStatus::Passed));
    }
}
