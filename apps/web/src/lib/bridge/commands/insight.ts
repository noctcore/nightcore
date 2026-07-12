/** Bridge commands — Insight (codebase analysis): run lifecycle, finding
 *  lifecycle, and decompose sub-task conversion. */
import { invoke } from '@tauri-apps/api/core';

import { tauriInvoke } from '../internal';
import type {
  AnalysisScope,
  DeepScanConfig,
  EffortLevel,
  FindingCategory,
  InsightRun,
  Task,
} from '../types';

// --- Insight (codebase analysis) ------------------------------------------

/** Start an Insight analysis run over the active project. Returns the `runId` the
 *  `analysis-*` events correlate by. Rejects outside Tauri (no active project).
 *
 *  `options.deep`, when present, opts the run into the multi-round convergence loop
 *  (issue #294). Callers MUST pass every {@link DeepScanConfig} field explicitly —
 *  the generated Rust struct defaults each field to `0` on deserialize (not the zod
 *  schema's 15/2/20), so an omitted field would silently zero that knob and produce
 *  a 0-round scan. `RunControls`' Deep toggle always supplies the full object. */
export async function startAnalysis(
  scope: AnalysisScope,
  categories: FindingCategory[],
  options: {
    model?: string | null;
    effort?: EffortLevel | null;
    providerId?: string | null;
    deep?: DeepScanConfig | null;
  } = {},
): Promise<string> {
  return invoke<string>('start_analysis', {
    scope,
    categories,
    model: options.model ?? null,
    effort: options.effort ?? null,
    providerId: options.providerId ?? null,
    deep: options.deep ?? null,
  });
}

/** Cancel an in-flight analysis run (aborts every category pass). No-op outside Tauri. */
export async function cancelAnalysis(runId: string): Promise<void> {
  await tauriInvoke<void>('cancel_analysis', { runId }, undefined);
}

/** All analysis runs for the active project, newest first. `[]` outside Tauri. */
export async function listInsightRuns(): Promise<InsightRun[]> {
  return tauriInvoke<InsightRun[]>('list_insight_runs', {}, []);
}

/** One analysis run by id, or `null`. `null` outside Tauri. */
export async function getInsightRun(runId: string): Promise<InsightRun | null> {
  return tauriInvoke<InsightRun | null>('get_insight_run', { runId }, null);
}

/** Mark a finding dismissed (it stays dismissed across future re-runs). Returns
 *  the updated run. No-op (`null`) outside Tauri. */
export async function dismissFinding(
  runId: string,
  findingId: string,
): Promise<InsightRun | null> {
  return tauriInvoke<InsightRun | null>(
    'dismiss_finding',
    { runId, findingId },
    null,
  );
}

/** Restore a dismissed finding back to open. Returns the updated run. */
export async function restoreFinding(
  runId: string,
  findingId: string,
): Promise<InsightRun | null> {
  return tauriInvoke<InsightRun | null>(
    'restore_finding',
    { runId, findingId },
    null,
  );
}

/** Convert a finding into a board task (idempotent). Returns the created task. */
export async function convertFindingToTask(
  runId: string,
  findingId: string,
): Promise<Task> {
  return invoke<Task>('convert_finding_to_task', { runId, findingId });
}

/** Decompose: convert ONE proposed sub-task of a decompose task into a board task
 *  (idempotent). Returns the updated PARENT task (its proposal now `converted`). */
export async function convertSubtask(
  parentId: string,
  subtaskId: string,
): Promise<Task> {
  return invoke<Task>('convert_subtask', { parentId, subtaskId });
}

/** Decompose: convert EVERY still-open proposed sub-task of a decompose task.
 *  Returns the updated PARENT task. */
export async function convertAllSubtasks(parentId: string): Promise<Task> {
  return invoke<Task>('convert_all_subtasks', { parentId });
}

/** Delete an analysis run and its file. No-op outside Tauri. */
export async function deleteInsightRun(runId: string): Promise<void> {
  await tauriInvoke<void>('delete_insight_run', { runId }, undefined);
}

