/** Bridge commands — Issue Triage (GitHub issue intake + validation). */
import { invoke } from '@tauri-apps/api/core';

import { tauriInvoke } from '../internal';
import type {
  EffortLevel,
  IssueComment,
  IssueLinkedPr,
  IssueSummary,
  IssueValidationRun,
  Task,
} from '../types';

// --- Issue Triage (GitHub issue intake + validation) ----------------------

/** One issue's body + first page of comments — the `gh` seam shape returned by
 *  `fetch_project_issue_detail` (`workflow/issue_triage/detail.rs`; not part of the
 *  engine NDJSON protocol, so hand-declared here). Every field is untrusted. */
export interface IssueDetail {
  body: string;
  comments: IssueComment[];
}

/** The payload `startIssueValidation` carries into the Rust seam. All GitHub-sourced
 *  text is untrusted — Rust wraps it in `untrusted_block` before the engine sees it,
 *  pre-fetches each OPEN linked PR's diff, and never trusts `issueAuthor`. */
export interface StartIssueValidationInput {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  /** Display-only GitHub login — never a trust input. */
  issueAuthor: string;
  labels: string[];
  comments: IssueComment[];
  /** List-view linked PRs (`{number,title,state}`); Rust fetches each OPEN PR's diff. */
  linkedPrs: IssueLinkedPr[];
}

/** The active project's OPEN GitHub issues (+ linked-PR badges), newest-updated
 *  first. `[]` outside Tauri; rejects (throws) inside Tauri on a `gh` failure so the
 *  list can surface "not a repo / gh not installed / auth" inline. */
export async function listProjectIssues(): Promise<IssueSummary[]> {
  return tauriInvoke<IssueSummary[]>('list_project_issues', {}, []);
}

/** Fetch one issue's body + first page of comments for the detail panel. Degrades to
 *  an empty detail outside Tauri; rejects on a `gh` failure inside Tauri. */
export async function fetchProjectIssueDetail(issueNumber: number): Promise<IssueDetail> {
  return tauriInvoke<IssueDetail>(
    'fetch_project_issue_detail',
    { issueNumber },
    { body: '', comments: [] },
  );
}

/** Start a read-only validation of one GitHub issue against the active project.
 *  Returns the `runId` the `issue-validation-*` events correlate by. Rejects outside
 *  Tauri (no active project). */
export async function startIssueValidation(
  input: StartIssueValidationInput,
  options: { model?: string | null; effort?: EffortLevel | null; providerId?: string | null } = {},
): Promise<string> {
  return invoke<string>('start_issue_validation', {
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    issueBody: input.issueBody,
    issueAuthor: input.issueAuthor,
    labels: input.labels,
    comments: input.comments,
    linkedPrs: input.linkedPrs,
    model: options.model ?? null,
    effort: options.effort ?? null,
    providerId: options.providerId ?? null,
  });
}

/** Cancel an in-flight validation (marks the run cancelled, then aborts the engine
 *  session). No-op outside Tauri. */
export async function cancelIssueValidation(runId: string): Promise<void> {
  await tauriInvoke<void>('cancel_issue_validation', { runId }, undefined);
}

/** All validation runs for the active project, newest first. `[]` outside Tauri. */
export async function listIssueValidations(): Promise<IssueValidationRun[]> {
  return tauriInvoke<IssueValidationRun[]>('list_issue_validations', {}, []);
}

/** One validation run by id, or `null`. `null` outside Tauri. */
export async function getIssueValidation(runId: string): Promise<IssueValidationRun | null> {
  return tauriInvoke<IssueValidationRun | null>('get_issue_validation', { runId }, null);
}

/** Delete a validation run and its file. No-op outside Tauri. */
export async function deleteIssueValidation(runId: string): Promise<void> {
  await tauriInvoke<void>('delete_issue_validation', { runId }, undefined);
}

/** Stamp a validation as viewed-now (drives the "new since you looked" affordance).
 *  Returns the updated run, or `null` outside Tauri. Best-effort — callers ignore it. */
export async function markIssueValidationViewed(
  runId: string,
): Promise<IssueValidationRun | null> {
  return tauriInvoke<IssueValidationRun | null>('mark_issue_validation_viewed', { runId }, null);
}

/** Build the EXACT comment markdown the post action would send, for the confirm
 *  dialog. Byte-identical to what `postIssueValidationComment` posts. Rejects outside
 *  Tauri (there is nothing to preview without a persisted verdict). */
export async function previewIssueComment(runId: string): Promise<string> {
  return invoke<string>('preview_issue_comment', { runId });
}

/** Post the validation verdict as a GitHub issue comment — a MUTATION, always behind
 *  the UI's confirmed preview dialog. Rebuilds the body from the stored verdict (never
 *  raw web text). Rejects outside Tauri. */
export async function postIssueValidationComment(runId: string): Promise<void> {
  await invoke<void>('post_issue_validation_comment', { runId });
}

/** Convert a validation verdict into a board task (idempotent). Returns the created
 *  (or already-linked) task, carrying `sourceRef` back to the validation. */
export async function convertIssueValidationToTask(runId: string): Promise<Task> {
  return invoke<Task>('convert_issue_validation_to_task', { runId });
}
