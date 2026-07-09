/** Bridge commands — the Readiness Scorecard (Profile). */
import { invoke } from '@tauri-apps/api/core';

import { tauriInvoke } from '../internal';
import type {
  EffortLevel,
  ScorecardDimension,
  ScorecardRun,
  Task,
} from '../types';

// --- Readiness Scorecard (Profile) ----------------------------------------

/** Start a Readiness Scorecard run over the active project. Returns the `runId` the
 *  `scorecard-*` events correlate by. Rejects outside Tauri (no active project). */
export async function startScorecard(
  dimensions: ScorecardDimension[],
  options: { model?: string | null; effort?: EffortLevel | null; providerId?: string | null } = {},
): Promise<string> {
  return invoke<string>('start_scorecard', {
    dimensions,
    model: options.model ?? null,
    effort: options.effort ?? null,
    providerId: options.providerId ?? null,
  });
}

/** Cancel an in-flight scorecard run (aborts every dimension pass). No-op outside Tauri. */
export async function cancelScorecard(runId: string): Promise<void> {
  await tauriInvoke<void>('cancel_scorecard', { runId }, undefined);
}

/** All scorecard runs for the active project, newest first. `[]` outside Tauri. */
export async function listScorecardRuns(): Promise<ScorecardRun[]> {
  return tauriInvoke<ScorecardRun[]>('list_scorecard_runs', {}, []);
}

/** One scorecard run by id, or `null`. `null` outside Tauri. */
export async function getScorecardRun(runId: string): Promise<ScorecardRun | null> {
  return tauriInvoke<ScorecardRun | null>('get_scorecard_run', { runId }, null);
}

/** Convert a reading into a board Build task that hardens that dimension
 *  (idempotent). Returns the created task. */
export async function convertReadingToTask(
  runId: string,
  readingId: string,
): Promise<Task> {
  return invoke<Task>('convert_reading_to_task', { runId, readingId });
}

/** Delete a scorecard run and its file. No-op outside Tauri. */
export async function deleteScorecardRun(runId: string): Promise<void> {
  await tauriInvoke<void>('delete_scorecard_run', { runId }, undefined);
}

