//! Staged-changes secret gate for Nightcore's own commit path (hardening #4c).
//!
//! `commit_task` stages with `git add -A` — a credential an agent (or the user)
//! dropped anywhere in the tree would be committed wholesale. Between staging and
//! committing, `workflow::merge::commit_task_blocking` calls [`scan_staged`],
//! which shells out to `gitleaks protect --staged --no-banner --redact` in the
//! task's commit dir and blocks the commit on findings. The safety posture:
//!
//! - **Opt-in by install**: gitleaks is not bundled; when it isn't on PATH the
//!   gate is a debug-logged no-op ([`ScanOutcome::ToolAbsent`]). Installing
//!   gitleaks arms the gate — there is no setting to flip.
//! - **Fail-closed once armed**: any non-zero gitleaks exit blocks the commit
//!   and surfaces a redacted tail of the report. Nothing is unstaged — the index
//!   is deliberately left as-is so the user can inspect exactly what was caught.
//! - **Fail-open on a broken launcher**: a scanner that resolves on PATH but
//!   cannot launch (permissions, corrupt binary) warn-logs and passes. Tradeoff:
//!   a broken scanner must not brick every commit — this gate is defence-in-
//!   depth in an opt-in tool, not the only line against leaked secrets.
//! - **No raw secret values, ever**: `--redact` makes gitleaks mask matched
//!   values in its own output, and only a bounded [`crate::gauntlet::tail_output`]
//!   of that already-redacted text reaches the error string. The report body is
//!   never written to the tracing log (same posture as the gauntlets).
//! - **Repo policy is respected implicitly**: gitleaks auto-loads the target
//!   repo's own `.gitleaks.toml` (custom rules + allowlist), so per-project
//!   tuning needs no Nightcore config.

use std::path::Path;

/// The outcome of a staged-changes secret scan. Only [`ScanOutcome::Findings`]
/// blocks a commit; the other two both mean "proceed" but are distinct so the
/// caller (and the log) can tell "scanned clean" from "gate not armed".
pub enum ScanOutcome {
    /// gitleaks ran and found nothing (exit 0) — or could not launch despite
    /// resolving on PATH (fail-open, see the module doc for the tradeoff).
    Clean,
    /// gitleaks is not installed: the gate is opt-in by install, so this passes.
    ToolAbsent,
    /// gitleaks exited non-zero: a redacted, bounded tail of its report. The
    /// caller must abort the commit and surface this to the user.
    Findings { summary: String },
}

/// Scan the staged changes in `dir` with gitleaks. See the module doc for the
/// full outcome mapping; callers treat everything but `Findings` as a pass.
pub fn scan_staged(dir: &Path) -> ScanOutcome {
    scan_staged_with(dir, "gitleaks")
}

/// [`scan_staged`] with the scanner binary as a parameter — the injection seam
/// the tests use to exercise the real spawn path (absent binary / exit-0 script /
/// exit-1 script) without depending on a gitleaks install on the test host.
fn scan_staged_with(dir: &Path, binary: &str) -> ScanOutcome {
    // Probe availability with `which` (PATHEXT-aware) instead of relying on a
    // NotFound spawn error: on Windows the platform resolver falls back to
    // `cmd /C <name>` for an unresolvable tool, and that spawn SUCCEEDS then
    // exits non-zero — which would misread "gitleaks not installed" as Findings
    // and block every commit on a machine without gitleaks.
    if which::which(binary).is_err() {
        tracing::debug!(
            target: "nightcore::secret_scan",
            binary,
            "gitleaks not on PATH — secret gate skipped (opt-in by install)"
        );
        return ScanOutcome::ToolAbsent;
    }

    // `protect --staged` scans the index (exactly what commit_staged is about to
    // commit); `--redact` masks matched values so the captured output is safe to
    // surface. Routed through the Windows-shim-aware spawner like every other
    // external tool.
    let output = crate::platform::std_command(binary)
        .args(["protect", "--staged", "--no-banner", "--redact"])
        .current_dir(dir)
        .output();

    match output {
        Ok(out) if out.status.success() => ScanOutcome::Clean,
        Ok(out) => {
            // Fail-closed: exit code + no body to the log (the redacted tail goes
            // only into the error string the UI shows).
            tracing::warn!(
                target: "nightcore::secret_scan",
                exit_code = ?out.status.code(),
                "gitleaks reported findings in the staged changes"
            );
            ScanOutcome::Findings {
                summary: crate::gauntlet::tail_output(&out.stdout, &out.stderr),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // TOCTOU guard: resolvable at probe time, gone at spawn time.
            tracing::debug!(
                target: "nightcore::secret_scan",
                binary,
                "gitleaks vanished between probe and spawn — secret gate skipped"
            );
            ScanOutcome::ToolAbsent
        }
        Err(e) => {
            // Fail-open (see module doc): an installed-but-broken scanner must
            // not brick every commit.
            tracing::warn!(
                target: "nightcore::secret_scan",
                error = %e,
                "gitleaks failed to launch — secret gate skipped this commit"
            );
            ScanOutcome::Clean
        }
    }
}

/// The user-facing error for a blocked commit: names the gate, the finding count
/// (parsed from gitleaks' own `leaks found: N` trailer when present), the way
/// out (`.gitleaks.toml` allowlist), and appends the redacted report tail. Built
/// here so the message and the redaction posture live next to each other.
pub fn blocked_message(summary: &str) -> String {
    let count = leak_count(summary)
        .map(|n| n.to_string())
        .unwrap_or_else(|| "one or more".to_string());
    format!(
        "secret scan blocked this commit: {count} potential secret(s) in staged changes — \
         review `gitleaks protect --staged` output, then remove or allowlist via \
         .gitleaks.toml\n\n{summary}"
    )
}

/// Parse the finding count from gitleaks' report trailer (`WRN leaks found: N`).
/// Pure and forgiving: `None` when the trailer is absent or unparseable (e.g. a
/// config error also exits non-zero), so the blocked message degrades to a
/// generic count rather than lying.
fn leak_count(summary: &str) -> Option<usize> {
    const MARKER: &str = "leaks found:";
    let idx = summary.rfind(MARKER)?;
    summary[idx + MARKER.len()..]
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_binary_is_tool_absent_not_findings() {
        // The opt-in contract: no gitleaks on PATH must map to ToolAbsent (a
        // pass), never to Findings — otherwise every commit on a machine without
        // gitleaks would be blocked.
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let outcome = scan_staged_with(tmp.path(), "definitely-not-a-real-binary-xyz");
        assert!(
            matches!(outcome, ScanOutcome::ToolAbsent),
            "a missing scanner is ToolAbsent"
        );
    }

    /// Write an executable shell script into `dir` to stand in for gitleaks, so
    /// the tests exercise the real spawn + exit-code mapping (not a mock).
    #[cfg(unix)]
    fn fake_scanner(dir: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-gitleaks.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
        let mut perms = std::fs::metadata(&path).expect("script metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod script");
        path
    }

    #[test]
    #[cfg(unix)]
    fn zero_exit_is_clean() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        let script = fake_scanner(tmp.path(), "exit 0");
        let outcome = scan_staged_with(tmp.path(), script.to_str().expect("utf8 path"));
        assert!(matches!(outcome, ScanOutcome::Clean), "exit 0 is Clean");
    }

    #[test]
    #[cfg(unix)]
    fn non_zero_exit_is_findings_with_the_output_tail() {
        let tmp = tempfile::TempDir::new().expect("temp dir");
        // Mimic gitleaks' shape: findings on stdout, the count trailer on stderr,
        // exit 1. The summary must carry both streams (tail_output combines them).
        let script = fake_scanner(
            tmp.path(),
            "echo 'Finding: aws_key=REDACTED'\necho 'WRN leaks found: 2' >&2\nexit 1",
        );
        let outcome = scan_staged_with(tmp.path(), script.to_str().expect("utf8 path"));
        let ScanOutcome::Findings { summary } = outcome else {
            panic!("a non-zero exit must map to Findings");
        };
        assert!(summary.contains("Finding: aws_key=REDACTED"), "stdout captured: {summary}");
        assert!(summary.contains("leaks found: 2"), "stderr captured: {summary}");
    }

    #[test]
    fn blocked_message_names_gate_count_and_way_out() {
        let msg = blocked_message("WRN leaks found: 3");
        assert!(msg.contains("secret scan blocked this commit"), "{msg}");
        assert!(msg.contains("3 potential secret(s)"), "{msg}");
        assert!(msg.contains(".gitleaks.toml"), "the way out is named: {msg}");

        // An unparseable summary (e.g. a gitleaks config error) still blocks,
        // with a generic count and the raw (redacted) summary appended.
        let msg = blocked_message("Failed to load config");
        assert!(msg.contains("one or more potential secret(s)"), "{msg}");
        assert!(msg.contains("Failed to load config"), "{msg}");
    }

    #[test]
    fn leak_count_parses_the_trailer_and_tolerates_garbage() {
        assert_eq!(leak_count("blah\nWRN leaks found: 12\n"), Some(12));
        // The LAST trailer wins (rfind) — earlier findings text may echo the phrase.
        assert_eq!(leak_count("leaks found: 1 … leaks found: 4"), Some(4));
        assert_eq!(leak_count("no trailer here"), None);
        assert_eq!(leak_count("leaks found: many"), None);
    }
}
