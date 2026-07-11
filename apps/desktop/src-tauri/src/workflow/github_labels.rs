//! The shared `nc:*` GitHub label vocabulary + ensure-at-use creation.
//!
//! Export ships BEFORE the two-way sync (#97, decision 5), so it CREATES this
//! neutral shared home #97 later EXTENDS (it adds its five status labels
//! `nc:queued`…`nc:failed` to this same table + reuses [`ensure_labels`] — it must
//! NOT re-define a parallel `issue_sync/labels.rs` seam, §10.3).
//!
//! Ensure-at-use: [`ensure_labels`] idempotently `POST`s each needed label before a
//! map's issues are created (labels are applied INLINE at issue-create, so they must
//! exist first). A `422 already_exists` counts as success; the ≤5 labels a map uses
//! are cached per `(project_path, name)` so steady-state exports skip the round-trip.
//! A label the token can't create (a 403 scope failure — or any non-422 error) is
//! non-fatal: [`ensure_labels`] returns `false` and the caller creates the issues
//! WITHOUT labels (degrade, §3.8) rather than failing the whole export. Label
//! names/colors/descriptions are our OWN fixed constants (never user input), so the
//! `-f key=value` argv is injection-safe (§4.7).

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::git::gh::{map_gh_failure, probe_gh, run_gh_bounded};

/// One managed label: a fixed SUFFIX/color/description triple (all trusted constants).
/// The suffix is prefix-independent — the configured `issue_label_prefix` composes the
/// full name via [`Label::full_name`], so BOTH the scan-map export and the issue-sync
/// writeback honor the same prefix (#97; the export used to hardcode `nc:`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Label {
    pub suffix: &'static str,
    pub color: &'static str,
    pub desc: &'static str,
}

impl Label {
    /// The full label name under the configured prefix (`"nc:"` + `"map"` → `"nc:map"`).
    pub(crate) fn full_name(&self, prefix: &str) -> String {
        format!("{prefix}{}", self.suffix)
    }
}

/// A Nightcore scan-map PARENT issue — also the supersede-discovery key (§3.10).
pub(crate) const NC_MAP: Label = Label {
    suffix: "map",
    color: "5319e7",
    desc: "A Nightcore scan-map parent issue",
};
/// A Nightcore scan-finding SUB-issue.
pub(crate) const NC_FINDING: Label = Label {
    suffix: "finding",
    color: "bfd4f2",
    desc: "A Nightcore scan-finding sub-issue",
};
/// Per-scan-kind label — from an Insight scan (also the per-kind discovery key).
pub(crate) const NC_INSIGHT: Label = Label {
    suffix: "insight",
    color: "0e8a16",
    desc: "From an Insight scan",
};
/// Per-scan-kind label — from a Scorecard scan.
pub(crate) const NC_SCORECARD: Label = Label {
    suffix: "scorecard",
    color: "fbca04",
    desc: "From a Scorecard scan",
};
/// Per-scan-kind label — from an Enforce/conventions scan.
pub(crate) const NC_ENFORCE: Label = Label {
    suffix: "enforce",
    color: "d93f0b",
    desc: "From an Enforce/conventions scan",
};

/// The ensure-cache: a `(project_path, label_name)` is remembered once ensured so a
/// steady-state export skips the `POST`. Keyed by path so switching projects never
/// reuses another repo's ensured set.
fn ensure_cache() -> &'static Mutex<HashSet<(String, String)>> {
    static CACHE: OnceLock<Mutex<HashSet<(String, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Ensure every label in `labels` exists on the repo rooted at `dir`, under the
/// configured `prefix`. Returns `true` when all are present (created, already-existed,
/// or cached), or `false` to signal the caller should DEGRADE — create the issues
/// without labels — when any label cannot be ensured (a 403 scope failure or any other
/// non-422 error). Never errors: labels are cosmetic, so a label problem must not sink
/// the export.
pub(crate) fn ensure_labels(
    dir: &Path,
    binary: &str,
    labels: &[Label],
    prefix: &str,
    deadline: Duration,
) -> bool {
    for label in labels {
        let name = label.full_name(prefix);
        if let Err(reason) =
            ensure_label_named(dir, binary, &name, label.color, label.desc, deadline)
        {
            tracing::warn!(
                target: "nightcore::issue_map",
                label = %name,
                error = %reason,
                "could not ensure label — exporting without labels (degrade)"
            );
            return false;
        }
    }
    true
}

/// Ensure ONE label exists by NAME/color/description (binary-parameterized — the
/// fake-`gh` test seam). THE single label-definition-ensure seam (#97 decision 5):
/// both the scan-map export (via [`ensure_labels`]) and the two-way issue-sync
/// writeback route their `POST …/labels` through here, so there is exactly one
/// create path + one ensure-cache — no forked parallel seam. A cached `(dir, name)`
/// short-circuits; otherwise `POST …/labels` with the fixed name/color/description
/// on argv (`-f`), treating `422 already_exists` as idempotent success.
pub(crate) fn ensure_label_named(
    dir: &Path,
    binary: &str,
    name: &str,
    color: &str,
    description: &str,
    deadline: Duration,
) -> Result<(), String> {
    let key = (dir.to_string_lossy().to_string(), name.to_string());
    if crate::sync::lock_or_recover(ensure_cache()).contains(&key) {
        return Ok(());
    }
    probe_gh(binary, "install it to manage GitHub labels")?;
    let out = run_gh_bounded(
        dir,
        binary,
        &[
            "api",
            "--method",
            "POST",
            "repos/{owner}/{repo}/labels",
            "-f",
            &format!("name={name}"),
            "-f",
            &format!("color={color}"),
            "-f",
            &format!("description={description}"),
        ],
        None,
        deadline,
        "timed out creating a label on GitHub — check your network and try again",
    )?;
    if out.status.success() || is_already_exists(&out.stdout) {
        crate::sync::lock_or_recover(ensure_cache()).insert(key);
        return Ok(());
    }
    Err(map_gh_failure(binary, "api", &out))
}

/// A `422 already_exists` is an idempotent success: `gh api` prints GitHub's error
/// JSON to STDOUT, whose `errors[].code` is `already_exists` when the label is there.
fn is_already_exists(stdout: &str) -> bool {
    stdout.contains("already_exists")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn fake_gh(dir: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-gh.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write script");
        let mut perms = std::fs::metadata(&path).expect("meta").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod");
        path
    }

    #[test]
    #[cfg(unix)]
    fn ensure_labels_tolerates_422_already_exists_and_caches() {
        let tmp = tempfile::TempDir::new().expect("tmp");
        // First: a fresh 422-already-exists; count invocations via an appended file.
        let script = fake_gh(
            tmp.path(),
            "echo call >> calls.txt\n\
             echo '{\"message\":\"Validation Failed\",\"errors\":[{\"code\":\"already_exists\"}]}'\n\
             echo 'gh: Validation Failed (HTTP 422)' >&2\nexit 1",
        );
        let bin = script.to_str().expect("utf8");
        assert!(ensure_labels(
            tmp.path(),
            bin,
            &[NC_MAP],
            "nc:",
            Duration::from_secs(5)
        ));
        // A second ensure of the SAME label is served from cache (no second call).
        assert!(ensure_labels(
            tmp.path(),
            bin,
            &[NC_MAP],
            "nc:",
            Duration::from_secs(5)
        ));
        let calls = std::fs::read_to_string(tmp.path().join("calls.txt")).expect("calls");
        assert_eq!(calls.lines().count(), 1, "the ensured label is cached");
    }

    #[test]
    #[cfg(unix)]
    fn ensure_labels_degrades_on_a_403_scope_failure() {
        let tmp = tempfile::TempDir::new().expect("tmp");
        let script = fake_gh(
            tmp.path(),
            "echo '{\"message\":\"Resource not accessible by integration\"}'\n\
             echo 'gh: HTTP 403' >&2\nexit 1",
        );
        let bin = script.to_str().expect("utf8");
        // A 403 → degrade signal (false), never an error/panic.
        assert!(!ensure_labels(
            tmp.path(),
            bin,
            &[NC_FINDING],
            "nc:",
            Duration::from_secs(5)
        ));
    }

    #[test]
    #[cfg(unix)]
    fn ensure_labels_posts_name_color_description_on_argv() {
        let tmp = tempfile::TempDir::new().expect("tmp");
        let script = fake_gh(tmp.path(), "printf '%s\\n' \"$@\" > args.txt\nexit 0");
        let bin = script.to_str().expect("utf8");
        assert!(ensure_labels(
            tmp.path(),
            bin,
            &[NC_INSIGHT],
            "nc:",
            Duration::from_secs(5)
        ));
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args");
        assert!(
            args.contains("repos/{owner}/{repo}/labels"),
            "labels endpoint: {args}"
        );
        assert!(args.contains("name=nc:insight"), "label name: {args}");
        assert!(args.contains("color=0e8a16"), "label color: {args}");
        assert!(args.contains("From an Insight scan"), "description: {args}");
    }

    #[test]
    #[cfg(unix)]
    fn ensure_labels_honors_a_remapped_prefix() {
        // A remapped `issue_label_prefix` composes the full name — the export honors the
        // same prefix as the sync writeback (fix T2-6).
        let tmp = tempfile::TempDir::new().expect("tmp");
        let script = fake_gh(tmp.path(), "printf '%s\\n' \"$@\" > args.txt\nexit 0");
        let bin = script.to_str().expect("utf8");
        assert!(ensure_labels(
            tmp.path(),
            bin,
            &[NC_MAP],
            "track:",
            Duration::from_secs(5)
        ));
        let args = std::fs::read_to_string(tmp.path().join("args.txt")).expect("args");
        assert!(
            args.contains("name=track:map"),
            "the configured prefix composes the label name: {args}"
        );
    }

    #[test]
    fn full_name_composes_suffix_under_the_prefix() {
        assert_eq!(NC_MAP.full_name("nc:"), "nc:map");
        assert_eq!(NC_INSIGHT.full_name("track:"), "track:insight");
    }
}
