//! The Harness convert-to-task handlers: mint a board task from a convention
//! finding or a task-shaped proposal.
//!
//! Split out of `harness/commands.rs` (issue #17 phase D) so that file stays under
//! the code-line cap. Both run the shared mint-first / atomic-CAS / rollback
//! protocol in [`crate::sidecar::convert`]; the model-derived body is fenced as
//! untrusted. Re-exported through `harness/mod.rs`, so the `generate_handler!`
//! command paths (`sidecar::convert_harness_finding_to_task` /
//! `sidecar::convert_harness_proposal`) resolve unchanged.

use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::infra::untrusted::untrusted_block;
use crate::sidecar::HARNESS_EVENT;
use crate::store::harness::{HarnessStore, StoredConventionFinding, StoredHarnessProposal};
use crate::store::TaskStore;
use crate::task::{sanitize_minted_title, Task, TaskKind, TASK_EVENT};

/// Convert a convention finding into a board task. Idempotent: if the finding already
/// links to a live task, that task is returned instead of minting a duplicate. Every
/// finding becomes a `build` task (the kind that edits + verifies); the finding's
/// model-derived text is fenced as untrusted in the description. Emits the task event and
/// a `finding-converted` notice so the open Harness view updates in place. Mirrors
/// Insight's `convert_finding_to_task` (same mint-first / atomic-CAS / rollback protocol).
#[tauri::command]
pub fn convert_harness_finding_to_task(
    app: AppHandle,
    store: State<'_, TaskStore>,
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    finding_id: String,
) -> Result<Task, String> {
    let finding = harness_store
        .get_finding(&run_id, &finding_id)
        .ok_or_else(|| format!("finding {finding_id} not found in run {run_id}"))?;

    // Build the task, then run the shared mint-first / atomic-CAS / rollback convert
    // protocol (see [`crate::sidecar::convert`]). Every finding becomes a Build task; its
    // model-derived text is fenced as untrusted inside `convention_task_description`.
    let mut task = Task::new(
        sanitize_minted_title(&finding.title, "Untitled convention"),
        convention_task_description(&finding),
    );
    task.kind = TaskKind::Build;
    // FROZEN mint prefix: paired with the source-ref.ts REGISTRY (`harness` →
    // Enforce stage) — do not rename. Renaming orphans every persisted token.
    task.source_ref = Some(format!("harness:{run_id}:{finding_id}"));

    let stamped = crate::sidecar::convert::convert_to_task(
        &store,
        finding.linked_task_id.as_deref(),
        task,
        |task_id| harness_store.link_finding_task(&run_id, &finding_id, task_id),
        |task_id| {
            harness_store
                .set_finding_status(
                    &run_id,
                    &finding_id,
                    "converted",
                    Some(Some(task_id.to_string())),
                )
                .map(|_| ())
        },
    )?;

    let _ = app.emit(TASK_EVENT, &stamped);
    let _ = app.emit(
        HARNESS_EVENT,
        json!({
            "type": "finding-converted",
            "runId": run_id,
            "findingId": finding_id,
            "taskId": stamped.id,
        }),
    );
    tracing::info!(target: "nightcore", task_id = %stamped.id, finding_id = %finding_id, "harness finding converted to task");
    Ok(stamped)
}

/// Build the markdown task description from a convention finding's fields + provenance.
/// The model-derived body is wrapped in an [`untrusted_block`] so the write-capable Build
/// agent treats it as data, not instructions (prompt-injection mitigation); only the
/// trusted provenance footer sits outside the fence.
fn convention_task_description(f: &StoredConventionFinding) -> String {
    let mut body = String::new();
    body.push_str(&f.description);
    body.push_str("\n\n");
    body.push_str(&format!(
        "**Lens:** {} · **Kind:** {} · **Severity:** {}\n",
        f.category, f.kind, f.severity
    ));
    if let Some(r) = &f.rationale {
        body.push_str(&format!("\n**Why it matters:** {r}\n"));
    }
    if let Some(s) = &f.suggestion {
        let heading = if f.kind == "gap" {
            "Change to adopt"
        } else {
            "Rule to codify"
        };
        body.push_str(&format!("\n**{heading}:** {s}\n"));
    }
    if !f.evidence.is_empty() {
        body.push_str("\n**Evidence:**\n");
        for e in &f.evidence {
            let lines = match (e.start_line, e.end_line) {
                (Some(s), Some(end)) if end != s => format!(":{s}-{end}"),
                (Some(s), _) => format!(":{s}"),
                _ => String::new(),
            };
            body.push_str(&format!("- `{}{}`\n", e.file, lines));
        }
    }
    if !f.tags.is_empty() {
        body.push_str(&format!("\n**Tags:** {}\n", f.tags.join(", ")));
    }
    let mut out = untrusted_block(&body);
    out.push_str("\n---\n_Created from a Harness convention finding._\n");
    out
}

/// Convert a task-shaped proposal into a board task. Idempotent (mirrors the finding
/// path). A proposal's `verify_command` becomes the task's `verify_command` so the
/// Structure-Lock gauntlet runs it before the paid reviewer (hardening module #1). The
/// proposal's model-derived text is fenced as untrusted in the description. Emits the
/// task event + a `proposal-converted` notice.
#[tauri::command]
pub fn convert_harness_proposal(
    app: AppHandle,
    store: State<'_, TaskStore>,
    harness_store: State<'_, HarnessStore>,
    run_id: String,
    proposal_id: String,
) -> Result<Task, String> {
    let proposal = harness_store
        .get_proposal(&run_id, &proposal_id)
        .ok_or_else(|| format!("proposal {proposal_id} not found in run {run_id}"))?;

    // Build the task, then run the shared mint-first / atomic-CAS / rollback convert
    // protocol (see [`crate::sidecar::convert`]).
    let mut task = Task::new(
        sanitize_minted_title(&proposal.title, "Untitled proposal"),
        proposal_task_description(&proposal),
    );
    task.kind = TaskKind::Build;
    // FROZEN mint prefix: paired with the source-ref.ts REGISTRY (`harness-proposal`
    // → Harden stage) — do not rename. Renaming orphans every persisted token.
    task.source_ref = Some(format!("harness-proposal:{run_id}:{proposal_id}"));
    // An agent-task proposal carries a machine-checkable done-command → the task's
    // verify_command, so the gauntlet gates the work before the reviewer. A blank command
    // is left as None (an empty check would pass trivially and add noise).
    task.verify_command = proposal
        .verify_command
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);

    let stamped = crate::sidecar::convert::convert_to_task(
        &store,
        proposal.linked_task_id.as_deref(),
        task,
        |task_id| harness_store.link_proposal_task(&run_id, &proposal_id, task_id),
        |task_id| {
            harness_store
                .set_proposal_status(
                    &run_id,
                    &proposal_id,
                    "converted",
                    Some(Some(task_id.to_string())),
                )
                .map(|_| ())
        },
    )?;

    let _ = app.emit(TASK_EVENT, &stamped);
    let _ = app.emit(
        HARNESS_EVENT,
        json!({
            "type": "proposal-converted",
            "runId": run_id,
            "proposalId": proposal_id,
            "taskId": stamped.id,
        }),
    );
    tracing::info!(target: "nightcore", task_id = %stamped.id, proposal_id = %proposal_id, "harness proposal converted to task");
    Ok(stamped)
}

/// Build the markdown task description from a proposal's fields + provenance. The whole
/// model-derived body (description, prompt, suggested check) is wrapped in an
/// [`untrusted_block`] so the write-capable Build agent treats it as data, not
/// instructions; only the trusted provenance footer sits outside the fence.
fn proposal_task_description(p: &StoredHarnessProposal) -> String {
    let mut body = String::new();
    body.push_str(&p.description);
    body.push('\n');
    if let Some(prompt) = &p.prompt {
        if !prompt.trim().is_empty() {
            body.push_str(&format!("\n**Task:** {prompt}\n"));
        }
    }
    if let Some(r) = &p.rationale {
        body.push_str(&format!("\n**Why it matters:** {r}\n"));
    }
    if !p.artifact_ids.is_empty() {
        body.push_str(&format!(
            "\n**Bundles {} artifact(s):** {}\n",
            p.artifact_ids.len(),
            p.artifact_ids.join(", ")
        ));
    }
    if let Some(cmd) = &p.verify_command {
        if !cmd.trim().is_empty() {
            body.push_str(&format!("\n**Verify with:** `{cmd}`\n"));
        }
    }
    if let Some(check) = &p.harness_check {
        body.push_str(&format!(
            "\n**Suggested Structure-Lock check:** `{}` (kind `{}`) — arm it after this lands.\n",
            check.command, check.kind
        ));
    }
    let mut out = untrusted_block(&body);
    out.push_str("\n---\n_Created from a Harness proposal._\n");
    out
}
