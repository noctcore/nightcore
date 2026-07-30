//! Bounded subprocess capture + JSON slicing for the drift substrates.
//!
//! The gate runner ([`super::super::runner`]) keeps only a failure TAIL; a drift
//! measurement needs the WHOLE machine-readable payload, so this leaf mirrors the same
//! spawn mechanics (no shell, stdin closed, per-check timeout) while retaining full
//! stdout. Every failure mode — launch error, timeout, non-zero exit — is surfaced via
//! `run_error` so a substrate can report `errored` instead of an empty measurement.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::infra::text::tail_output;

/// One bounded capture of a subprocess, keeping FULL stdout.
pub(super) struct CaptureOutcome {
    pub(super) exit_code: Option<i32>,
    pub(super) stdout: String,
    /// A launch / timeout / non-zero-exit message; `None` on a clean exit-0 run.
    pub(super) run_error: Option<String>,
    pub(super) duration_ms: u64,
}

pub(super) fn run_capture(
    program: &str,
    args: &[String],
    dir: &Path,
    timeout: Duration,
) -> CaptureOutcome {
    let start = Instant::now();
    let spawned = crate::platform::std_command(program)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let child = match spawned {
        Ok(child) => child,
        Err(e) => {
            return CaptureOutcome {
                exit_code: None,
                stdout: String::new(),
                run_error: Some(format!("failed to launch `{program}`: {e}")),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    match crate::git::run::drain_and_wait(child, None, timeout) {
        Ok(Some(out)) => {
            let run_error = if out.status.success() {
                None
            } else {
                Some(tail_output(out.stdout.as_bytes(), out.stderr.as_bytes()))
            };
            CaptureOutcome {
                exit_code: out.status.code(),
                stdout: out.stdout,
                run_error,
                duration_ms: start.elapsed().as_millis() as u64,
            }
        }
        Ok(None) => CaptureOutcome {
            exit_code: None,
            stdout: String::new(),
            run_error: Some(format!(
                "timed out after {}ms (the check was killed)",
                timeout.as_millis()
            )),
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Err(e) => CaptureOutcome {
            exit_code: None,
            stdout: String::new(),
            run_error: Some(format!("could not run the check: {e}")),
            duration_ms: start.elapsed().as_millis() as u64,
        },
    }
}

/// Extract the `{ … }` JSON object from captured stdout. The lint-meta CLI prints only
/// the JSON on `--json`, but a script runner could prepend a banner line, so we slice
/// from the first `{` to the last `}` (returns `None` when there is no object at all).
pub(super) fn extract_json(stdout: &str) -> Option<&str> {
    slice_between(stdout, '{', '}')
}

/// Extract the `[ … ]` JSON array from captured stdout (ESLint's `json` formatter emits
/// a top-level array). The array counterpart of [`extract_json`].
pub(super) fn extract_json_array(stdout: &str) -> Option<&str> {
    slice_between(stdout, '[', ']')
}

fn slice_between(stdout: &str, open: char, close: char) -> Option<&str> {
    let start = stdout.find(open)?;
    let end = stdout.rfind(close)?;
    if end < start {
        return None;
    }
    Some(&stdout[start..=end])
}
