/** Bridge commands — mid/post-run interaction: provider config inspection,
 *  interactive permissions, plan approval, commit/merge, and the verification gate. */
import { invoke } from '@tauri-apps/api/core';

import { tauriInvoke } from '../internal';
import { MOCK_PROVIDER_CONFIG } from '../mocks';
import type {
  GauntletResult,
  ProviderConfigSnapshot,
  QuestionAnswer,
} from '../types';

// --- Provider configuration inspector (read-only) -------------------------

/** Read the default provider's RESOLVED configuration for a project — its MCP
 *  servers, skills, subagents, and scalar extras — for the read-only inspector.
 *  Omit `projectPath` to inspect the ACTIVE project (the board-header entry point);
 *  pass one to inspect another root. Each section degrades independently
 *  (supported / unsupported / unavailable), so the snapshot always resolves.
 *  Returns a populated mock outside Tauri (browser preview). */
export async function getProviderConfig(
  projectPath?: string,
): Promise<ProviderConfigSnapshot> {
  return tauriInvoke<ProviderConfigSnapshot>(
    'get_provider_config',
    { dir: projectPath ?? null },
    MOCK_PROVIDER_CONFIG,
  );
}

// --- Interactive permissions ----------------------------------------------

/** A surface decision for a parked permission prompt. Mirrors the Rust
 *  `respond_permission` arguments. An allow may rewrite the tool input; a deny may
 *  carry a short reason returned to the model. */
export type PermissionDecision = 'allow' | 'deny';

/** Answer a parked permission prompt (`nc:permission`). An allow may rewrite the
 *  tool input via `updatedInput`; a deny may carry a short `message` reason.
 *  No-ops outside Tauri (browser preview). */
export async function respondPermission(
  taskId: string,
  requestId: string,
  decision: PermissionDecision,
  options: { updatedInput?: Record<string, unknown>; message?: string } = {},
): Promise<void> {
  await tauriInvoke<void>(
    'respond_permission',
    {
      taskId,
      requestId,
      decision,
      updatedInput: options.updatedInput ?? null,
      message: options.message ?? null,
    },
    undefined,
  );
}

/** Answer a parked `AskUserQuestion` prompt (`nc:question`). `answer` is either
 *  the user's choices (`{behavior:'answer', answers}`) or a skip
 *  (`{behavior:'cancel'}`). No-ops outside Tauri (browser preview). */
export async function answerQuestion(
  taskId: string,
  requestId: string,
  answer: QuestionAnswer,
): Promise<void> {
  await tauriInvoke<void>(
    'answer_question',
    { taskId, requestId, answer },
    undefined,
  );
}

// --- Plan approval --------------------------------------------------------

/** Approve a waiting plan: the same session switches to building it. */
export async function approveTask(id: string): Promise<void> {
  await invoke('approve_task', { id });
}

/** Reject a waiting plan: the session ends and the task fails. */
export async function rejectTask(id: string): Promise<void> {
  await invoke('reject_task', { id });
}

/** Send a waiting plan back to the backlog with the plan kept for editing. */
export async function refineTask(id: string): Promise<void> {
  await invoke('refine_task', { id });
}

// --- Commit / merge -------------------------------------------------------

/** Commit a verified task's worktree (git add -A + commit from its title).
 *  Rejects with "nothing to commit" when the tree is clean. */
export async function commitTask(id: string): Promise<void> {
  await invoke('commit_task', { id });
}

/** Merge a verified task's branch into the project base. Rejects (and marks the
 *  task `conflict`) on a merge conflict — never forced. The backend gates this on
 *  `verified == true` and a passing gauntlet; an unverified task is refused. */
export async function mergeTask(id: string): Promise<void> {
  await invoke('merge_task', { id });
}

// --- Verification gate ----------------------------------------------------

/** Accept a parked verification (CHANGES_REQUESTED budget-exhausted / FAIL /
 *  inconclusive): the user overrides the reviewer → `verified = true`, `done`.
 *  The worktree is retained for commit/merge. */
export async function acceptReview(id: string): Promise<void> {
  await invoke('accept_review', { id });
}

/** Reject a parked verification: the task drops back to the backlog (keeping
 *  `task.review` for context) rather than merging. */
export async function rejectReview(id: string): Promise<void> {
  await invoke('reject_review', { id });
}

/** Re-dispatch a reviewer session against the current worktree without a rebuild
 *  — a fresh verification pass over the existing diff. */
export async function rerunVerification(id: string): Promise<void> {
  await invoke('rerun_verification', { id });
}

/** Run the deterministic pre-merge readiness gauntlet (typecheck → lint → test,
 *  stop at first failure) over the task's worktree and return its structured
 *  result. Drives the Verified column's "Run checks" action; a project with no
 *  detectable tooling passes trivially. No-op (empty pass) outside Tauri. */
export async function runGauntlet(id: string): Promise<GauntletResult> {
  return tauriInvoke<GauntletResult>('run_gauntlet', { id }, { passed: true, steps: [] });
}
