//! The [`ConventionDrift`] record builders shared by every drift substrate: the wire
//! status strings, the stable id / carry-forward key, the always-rendered `method`
//! label, and the fail-visible `errored` record.
//!
//! Kept in one leaf so the non-negotiable product rule — never `clean`/`drifted` without
//! a `method` + real counts — has exactly one place where a record can be built WITHOUT
//! counts, and that place always yields `errored`.

use super::super::config::HarnessCheckKind;
use crate::store::types::ConventionDrift;

/// Drift statuses as their wire strings (mirroring `ConventionDriftStatusSchema`).
pub(super) const STATUS_CLEAN: &str = "clean";
pub(super) const STATUS_DRIFTED: &str = "drifted";
pub(super) const STATUS_ERRORED: &str = "errored";

/// The `errored` drift record — fail-visible with zeroed counts + a human reason.
pub(super) fn errored_drift(
    name: &str,
    fingerprint: &str,
    method: &str,
    reason: String,
) -> ConventionDrift {
    ConventionDrift {
        id: drift_id(fingerprint),
        convention_fingerprint: fingerprint.to_string(),
        category: String::new(),
        title: name.to_string(),
        status: STATUS_ERRORED.to_string(),
        method: method.to_string(),
        sites_matched: 0,
        sites_checked: 0,
        check_name: Some(name.to_string()),
        error_reason: Some(reason),
        fingerprint: fingerprint.to_string(),
    }
}

/// `method` string (ALWAYS rendered): the tool + rule/name that determined the drift.
pub(super) fn method_for(kind: HarnessCheckKind, name: &str, command: &str) -> String {
    match kind {
        HarnessCheckKind::LintMeta => format!("lint-meta: {name}"),
        HarnessCheckKind::EslintRule => format!("eslint: {name}"),
        HarnessCheckKind::Shell => format!("shell: {command}"),
        other => format!("{}: {name}", other.as_wire()),
    }
}

/// Stable drift id / carry-forward key: `drift-<conventionFingerprint>`.
pub(super) fn drift_id(fingerprint: &str) -> String {
    format!("drift-{fingerprint}")
}
