//! The opt-in DEEP CONFORMANCE AUDIT seam (issue #279).
//!
//! Drift v1's EnforceRun measures conformance MECHANICALLY — it runs the human-armed
//! lint-meta / ESLint checks and counts their violating sites. Every convention no
//! deterministic check can express stays honestly `uncheckable`. The deep audit is the
//! expensive other half: a bounded, read-only MODEL pass that re-reads those sites.
//!
//! ## Why here (next to `rule_tester` / `list_models`)
//!
//! The pass needs a provider session, which lives in the Bun sidecar — so this is a
//! request/reply [`SurfaceQuery`] through the sidecar [`query`] transport, exactly like
//! [`super::rule_tester`]. What Rust owns is the part that must NOT be model-authored:
//! which project is read, which conventions are eligible, and how many.
//!
//! ## Bounds (the opt-in's whole point)
//!
//!  - **Server-resolved project.** The repo the pass reads is the ACTIVE project, never
//!    a caller-supplied path — the pass reads files.
//!  - **Unmechanized conventions only.** A convention already covered by an armed drift
//!    check is EXCLUDED: paying a model to re-judge what a deterministic check already
//!    counted is strictly worse (slower, dearer, and less trustworthy).
//!  - **Hard cap.** At most [`MAX_AUDIT_CONVENTIONS`] conventions per run, so the cost
//!    the UI quotes before the user opts in is the cost they can actually incur.
//!
//! ## Honesty
//!
//! The engine grounds every returned record against the requested fingerprints and
//! downgrades any verdict it cannot back with examined sites to `errored`. These records
//! then ride the SAME drift plane as the mechanical ones, distinguished by their
//! `method` (`deep-audit: <model>`) and by the run's persisted `deep` flag — which is
//! part of the carry-forward comparability basis, so a deep run is never diffed against
//! a shallow one.

use tauri::AppHandle;

use crate::contracts::{ConformanceAuditResult, ConformanceAuditTarget, SurfaceQuery};
use crate::store::types::ConventionDrift;

use super::query;

/// Hard cap on conventions per deep audit. Mirrors the engine's own cap; enforced on
/// BOTH sides so neither a stale UI nor a future caller can widen the bill.
pub(crate) const MAX_AUDIT_CONVENTIONS: usize = 12;

/// Select the conventions a deep audit should re-read: the scan's convention findings
/// MINUS the ones an armed drift check already measures, capped.
///
/// Pure over its inputs (no store, no AppHandle) so the selection rule — the thing that
/// decides what the user pays for — is unit-testable.
pub(crate) fn audit_targets(
    conventions: &[(String, String, String, String)],
    measured_fingerprints: &[String],
) -> Vec<ConformanceAuditTarget> {
    conventions
        .iter()
        .filter(|(fingerprint, _, _, _)| {
            !fingerprint.is_empty() && !measured_fingerprints.iter().any(|m| m == fingerprint)
        })
        .take(MAX_AUDIT_CONVENTIONS)
        .map(
            |(fingerprint, category, title, description)| ConformanceAuditTarget {
                fingerprint: fingerprint.clone(),
                category: category.clone(),
                title: title.clone(),
                description: description.clone(),
            },
        )
        .collect()
}

/// Map the engine's wire drift records onto the store's [`ConventionDrift`] shape (the
/// ts-rs boundary type the panel already renders). A straight field copy — the engine
/// has already applied the honesty rules.
pub(crate) fn to_store_drift(result: &ConformanceAuditResult) -> Vec<ConventionDrift> {
    result
        .drift
        .iter()
        .map(|d| ConventionDrift {
            id: d.id.clone(),
            convention_fingerprint: d.convention_fingerprint.clone(),
            category: d.category.clone(),
            title: d.title.clone(),
            status: drift_status_wire(&d.status).to_string(),
            method: d.method.clone(),
            sites_matched: d.sites_matched.max(0.0) as u64,
            sites_checked: d.sites_checked.max(0.0) as u64,
            check_name: d.check_name.clone(),
            error_reason: d.error_reason.clone(),
            fingerprint: d.fingerprint.clone(),
        })
        .collect()
}

/// The wire string for a codegen'd `ConventionDriftStatus` (the store keeps `status` as
/// a lenient wire string, matching how `category` rides).
fn drift_status_wire(status: &crate::contracts::ConventionDriftStatus) -> &'static str {
    use crate::contracts::ConventionDriftStatus as S;
    match status {
        S::Clean => "clean",
        S::Drifted => "drifted",
        S::Uncheckable => "uncheckable",
        S::Errored => "errored",
    }
}

/// Ask the engine to run the deep conformance audit over `project_path` for `targets`.
/// Fails SOFT end to end: an engine-side degradation arrives inside the result (as
/// `errored` records plus an `error`), so only a transport failure is an `Err`.
pub(crate) async fn run_audit(
    app: &AppHandle,
    project_path: String,
    targets: Vec<ConformanceAuditTarget>,
    max_budget_usd: Option<f64>,
) -> Result<ConformanceAuditResult, String> {
    let reply = query(
        app,
        SurfaceQuery::AuditConformance {
            // `requestId` is overwritten by `query` with a fresh uuid.
            request_id: String::new(),
            project_path,
            conventions: targets,
            max_turns: None,
            max_budget_usd,
            model: None,
        },
    )
    .await?;
    if reply.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(reply
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("audit-conformance query failed")
            .to_string());
    }
    let result = reply
        .get("conformanceAudit")
        .ok_or("audit-conformance reply missing its result")?;
    serde_json::from_value(result.clone())
        .map_err(|e| format!("malformed conformance-audit result from the engine: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convention(fp: &str) -> (String, String, String, String) {
        (
            fp.to_string(),
            "folder-structure".to_string(),
            format!("convention {fp}"),
            "does a thing".to_string(),
        )
    }

    #[test]
    fn a_convention_an_armed_check_already_measures_is_never_re_audited() {
        // Paying a model to re-judge what a deterministic check already counted is
        // strictly worse — the mechanical record wins and the convention is skipped.
        let conventions = vec![convention("a"), convention("b"), convention("c")];
        let targets = audit_targets(&conventions, &["b".to_string()]);
        assert_eq!(
            targets
                .iter()
                .map(|t| t.fingerprint.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "c"]
        );
    }

    #[test]
    fn the_target_list_is_hard_capped() {
        let conventions: Vec<_> = (0..40).map(|i| convention(&format!("fp{i}"))).collect();
        assert_eq!(
            audit_targets(&conventions, &[]).len(),
            MAX_AUDIT_CONVENTIONS
        );
    }

    #[test]
    fn a_convention_with_no_fingerprint_is_not_auditable() {
        // Without a fingerprint there is no join key, so a record could never reach the
        // drift plane — never pay to audit one.
        let conventions = vec![convention(""), convention("a")];
        let targets = audit_targets(&conventions, &[]);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].fingerprint, "a");
    }

    #[test]
    fn every_armed_fingerprint_measured_leaves_nothing_to_audit() {
        let conventions = vec![convention("a")];
        assert!(audit_targets(&conventions, &["a".to_string()]).is_empty());
    }
}
