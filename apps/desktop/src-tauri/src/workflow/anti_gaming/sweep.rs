//! The sweep entry point + its git plumbing: resolve the build's committed diff
//! (`merge-base(base, HEAD)..HEAD` in the review worktree), run the pure
//! detectors + the ledger detector over it, and append ONE Failed `anti-gaming`
//! [`StructureLockCheck`] when there is evidence. Infrastructure failures
//! (no merge-base, git error) WARN and skip — the gate never fails on its own
//! plumbing.

use std::path::Path;

use super::detect::detect_findings;
use super::ledger::detect_ledger_findings;
use super::report::render_evidence;
use crate::store::types::{StepStatus, StructureLockCheck, StructureLockResult};

/// The name AND kind of the appended check — a built-in, so the two coincide
/// (manifest checks carry a user name + a kind vocabulary; this has neither).
const CHECK_NAME: &str = "anti-gaming";

/// Run the sweep over the build's committed diff (`merge-base(base, HEAD)..HEAD`
/// in the review worktree, base resolved from the PROJECT root's HEAD) and append
/// a Failed `anti-gaming` check when it finds evidence. Infrastructure failures
/// (no merge-base, git error) WARN and skip — the sweep never fails the gate on
/// its own plumbing, only on what it actually saw in the diff.
///
/// `ledger` is the task's session flight-recorder file (module #5): its ALLOWED
/// Bash history is scanned for `--no-verify` — the hook-bypass half the diff
/// can't see (a command leaves no diff) — and any hit folds into the SAME
/// evidence list. A missing/unparseable ledger contributes nothing (the same
/// warn-and-skip posture as the git plumbing; runs predate the recorder).
pub fn append_anti_gaming_check(
    result: &mut StructureLockResult,
    review_dir: &Path,
    project_root: &Path,
    ledger: Option<&Path>,
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

    let mut findings = detect_findings(&diff);
    if let Some(ledger) = ledger {
        findings.extend(detect_ledger_findings(&crate::store::ledger::read_records(
            ledger,
        )));
    }
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
