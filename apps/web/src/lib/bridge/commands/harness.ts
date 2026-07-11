/** Bridge commands — the Harness (codebase convention auditor): run + item
 *  lifecycle, artifact apply / arm, policy authoring, and the injection scan. */
import { invoke } from '@tauri-apps/api/core';

import { tauriInvoke } from '../internal';
import { MOCK_INJECTION_FLAGS, MOCK_POLICY_FILE } from '../mocks';
import type {
  ArmedCheckFile,
  ArmedChecksState,
  ConventionCategory,
  EffortLevel,
  HarnessPolicyFile,
  HarnessPolicyPatch,
  HarnessRun,
  InjectionFlag,
  Task,
} from '../types';

/** The mock Checks Manager view returned outside Tauri, so the armed-checks panel
 *  renders deterministically in Storybook + browser preview (kept local — the
 *  shared `mocks.ts` is at its size cap). */
const MOCK_ARMED_CHECKS_STATE: ArmedChecksState = {
  checks: [
    {
      name: 'folder-per-component',
      kind: 'lint-plugin',
      command: 'npx eslint .',
      enabled: true,
      timeoutMs: 120000,
      lastResult: { status: 'passed', exitCode: 0, durationMs: 3400 },
    },
    {
      name: 'architecture-boundaries',
      kind: 'dependency-cruiser',
      command: 'npx depcruise src',
      enabled: false,
    },
  ],
  lastRun: { passed: true, ranAt: Date.now() - 5 * 60 * 1000 },
};

// --- Harness (codebase convention auditor) --------------------------------

/** Start a Harness scan over the active project. Returns the `runId` the
 *  `harness-*` events correlate by. Rejects outside Tauri (no active project). */
export async function startHarnessScan(
  categories: ConventionCategory[],
  options: { model?: string | null; effort?: EffortLevel | null; providerId?: string | null } = {},
): Promise<string> {
  return invoke<string>('start_harness_scan', {
    categories,
    model: options.model ?? null,
    effort: options.effort ?? null,
    providerId: options.providerId ?? null,
  });
}

/** Cancel an in-flight Harness scan (aborts every lens pass). No-op outside Tauri. */
export async function cancelHarnessScan(runId: string): Promise<void> {
  await tauriInvoke<void>('cancel_harness_scan', { runId }, undefined);
}

/** All Harness runs for the active project, newest first. `[]` outside Tauri. */
export async function listHarnessRuns(): Promise<HarnessRun[]> {
  return tauriInvoke<HarnessRun[]>('list_harness_runs', {}, []);
}

/** One Harness run by id, or `null`. `null` outside Tauri. */
export async function getHarnessRun(runId: string): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>('get_harness_run', { runId }, null);
}

/** Delete a Harness run and its file. No-op outside Tauri. */
export async function deleteHarnessRun(runId: string): Promise<void> {
  await tauriInvoke<void>('delete_harness_run', { runId }, undefined);
}

/** Mark a convention finding dismissed (it stays dismissed across future
 *  re-scans). Returns the updated run. No-op (`null`) outside Tauri. */
export async function dismissHarnessFinding(
  runId: string,
  findingId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'dismiss_harness_finding',
    { runId, findingId },
    null,
  );
}

/** Restore a dismissed convention finding back to open. Returns the updated run. */
export async function restoreHarnessFinding(
  runId: string,
  findingId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'restore_harness_finding',
    { runId, findingId },
    null,
  );
}

/** Convert a convention finding into a board task (idempotent). Returns the created
 *  task. Uses raw `invoke` (throws outside Tauri), mirroring `convertFindingToTask`. */
export async function convertHarnessFindingToTask(
  runId: string,
  findingId: string,
): Promise<Task> {
  return invoke<Task>('convert_harness_finding_to_task', { runId, findingId });
}

/** Mark a task-shaped proposal dismissed (it stays dismissed across future
 *  re-scans). Returns the updated run. No-op (`null`) outside Tauri. */
export async function dismissHarnessProposal(
  runId: string,
  proposalId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'dismiss_harness_proposal',
    { runId, proposalId },
    null,
  );
}

/** Restore a dismissed proposal back to proposed. Returns the updated run. */
export async function restoreHarnessProposal(
  runId: string,
  proposalId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'restore_harness_proposal',
    { runId, proposalId },
    null,
  );
}

/** Convert a task-shaped proposal into a board task (idempotent). Returns the created
 *  task. Uses raw `invoke` (throws outside Tauri), mirroring `convertHarnessFindingToTask`. */
export async function convertHarnessProposal(
  runId: string,
  proposalId: string,
): Promise<Task> {
  return invoke<Task>('convert_harness_proposal', { runId, proposalId });
}

/** Mark a proposed artifact dismissed (it stays dismissed across future
 *  re-scans). Returns the updated run. No-op (`null`) outside Tauri. */
export async function dismissHarnessArtifact(
  runId: string,
  artifactId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'dismiss_harness_artifact',
    { runId, artifactId },
    null,
  );
}

/** Restore a dismissed proposed artifact back to proposed. Returns the updated run. */
export async function restoreHarnessArtifact(
  runId: string,
  artifactId: string,
): Promise<HarnessRun | null> {
  return tauriInvoke<HarnessRun | null>(
    'restore_harness_artifact',
    { runId, artifactId },
    null,
  );
}

/** Apply a proposed artifact into the project — WRITES to disk. `create` refuses
 *  to overwrite an existing file; `merge-section` updates a managed block. Returns
 *  the updated run, or rejects with the write error (surfaced inline). Rejects
 *  outside Tauri (no active project). */
export async function applyHarnessArtifact(
  runId: string,
  artifactId: string,
): Promise<HarnessRun> {
  return invoke<HarnessRun>('apply_harness_artifact', { runId, artifactId });
}

/** Apply an `apply-artifacts` proposal as a bundle — WRITES every referenced artifact to
 *  disk through the same hardened path as {@link applyHarnessArtifact}, then marks the
 *  proposal applied. Idempotent + partial-failure-aware (a failed write leaves the
 *  succeeded artifacts applied and rejects with the error). Rejecting an `agent-task`
 *  proposal (no artifacts) is expected — convert it instead. Rejects outside Tauri. */
export async function applyHarnessProposal(
  runId: string,
  proposalId: string,
): Promise<HarnessRun> {
  return invoke<HarnessRun>('apply_harness_proposal', { runId, proposalId });
}

/** Arm a Structure-Lock check into the scanned project's `.nightcore/harness.json` so
 *  the zero-cost gauntlet runs it before every future reviewer + at merge. The `command`
 *  is what the user reviewed and confirmed (the human gate) — never model-derived. Uses
 *  raw `invoke` (throws outside Tauri) so a failed write surfaces to the caller. */
export async function armHarnessGauntletCheck(
  runId: string,
  name: string,
  kind: string,
  command: string,
  /** For a `lint-plugin` arm, the applied plugin's repo-relative path — the Rust
   *  preflight refuses to arm it if no ESLint config actually references it (the
   *  placebo-gate fix). `null` for a hand-authored command (no plugin to check). */
  requireWired: string | null = null,
): Promise<void> {
  await invoke<void>('arm_harness_gauntlet_check', {
    runId,
    name,
    kind,
    command,
    requireWired,
  });
}

// --- Checks Manager (Enforce, T7): the armed structure-lock checks -----------

/** The ACTIVE project's armed checks (incl. disabled), each folded with its last
 *  on-demand result + the run-level summary. Returns a mock outside Tauri. */
export async function listArmedChecks(): Promise<ArmedChecksState> {
  return tauriInvoke<ArmedChecksState>('list_armed_checks', {}, MOCK_ARMED_CHECKS_STATE);
}

/** Enable / disable one armed check by name (merge-by-key over the manifest).
 *  Returns the refreshed view. Rejects outside Tauri so a failed write surfaces. */
export async function setArmedCheckEnabled(
  name: string,
  enabled: boolean,
): Promise<ArmedChecksState> {
  return invoke<ArmedChecksState>('set_armed_check_enabled', { name, enabled });
}

/** Remove (disarm) one armed check by name. Returns the refreshed view. */
export async function removeArmedCheck(name: string): Promise<ArmedChecksState> {
  return invoke<ArmedChecksState>('remove_armed_check', { name });
}

/** Edit an existing armed check identified by `originalName` (validates kind +
 *  non-empty name/command Rust-side). Returns the refreshed view. */
export async function updateArmedCheck(
  originalName: string,
  updated: ArmedCheckFile,
): Promise<ArmedChecksState> {
  return invoke<ArmedChecksState>('update_armed_check', { originalName, updated });
}

/** Run the whole armed gauntlet against the active project root now, persist the
 *  result as the last run, and return the refreshed view. Rejects outside Tauri. */
export async function runArmedChecksNow(): Promise<ArmedChecksState> {
  return invoke<ArmedChecksState>('run_armed_checks_now', {});
}

// --- Harness policy authoring + injection scan ------------------------------

/** Read the ACTIVE project's harness policy block (`.nightcore/harness.json`),
 *  with defaults when the manifest/key is absent; `manifestExists` tells the
 *  editor whether saving edits or creates the file. Returns a mock outside Tauri. */
export async function getHarnessPolicyFile(): Promise<HarnessPolicyFile> {
  return tauriInvoke<HarnessPolicyFile>('get_harness_policy_file', {}, MOCK_POLICY_FILE);
}

/** Merge a policy patch into the active project's `.nightcore/harness.json` —
 *  WRITES to disk (creating the manifest when absent) and returns the updated
 *  policy. Only the keys present in the patch change; unknown manifest keys
 *  survive. Uses raw `invoke` (throws outside Tauri) so a failed write surfaces
 *  to the caller instead of silently "saving". */
export async function updateHarnessPolicyFile(
  patch: HarnessPolicyPatch,
): Promise<HarnessPolicyFile> {
  return invoke<HarnessPolicyFile>('update_harness_policy_file', { patch });
}

/** Sweep the active project's git-tracked text files for prompt-injection-shaped
 *  content (invisible Unicode tags, zero-width runs, bidi overrides, instruction
 *  phrases), returning the flagged paths + reasons for human review. Detection
 *  only — quarantining is the user's explicit denyReadPaths update. Returns mock
 *  flags outside Tauri. */
export async function scanInjectionSurface(): Promise<InjectionFlag[]> {
  return tauriInvoke<InjectionFlag[]>('scan_injection_surface', {}, MOCK_INJECTION_FLAGS);
}

