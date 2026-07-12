/**
 * The runner + reporting — a faithful Node port of the in-process Rust runner
 * (`workflow/gauntlet_project/runner.rs`), minus the Nightcore-orchestration-only
 * machinery (retry-once/flaky, the security-critical no-retry exclusion, drift
 * substrates, and the task verify-command append — none of which has a CI
 * meaning). Statuses are therefore only `passed` / `failed`.
 *
 * FULL-RUN semantics (matching the live Rust runner, NOT the spec's stale
 * stop-at-first text): every enabled check runs and records its own outcome, so
 * a human reading CI sees the WHOLE failure set at once instead of one failure
 * per pushed round. Each check is wall-clock BOUNDED by its `timeoutMs`; a
 * timeout is a FAILED check (fail-closed — never a silent pass). `passed` is
 * false iff ANY check failed; `failedCheck` names the FIRST failed check
 * (back-compat).
 *
 * Pure over an injected {@link SpawnFn} so it is unit-testable without spawning.
 */
import type { PlannedCheck } from './manifest.js';

/** A check outcome. `skipped`/`flaky` from the in-process runner are dropped. */
export type CheckStatus = 'passed' | 'failed';

/**
 * The outcome of one structure-lock check. Wire-compatible (camelCase) with the
 * Rust `StructureLockCheck` — `exitCode` / `output` / `durationMs` are omitted
 * when absent.
 */
export interface StructureLockCheck {
  name: string;
  kind: string;
  command: string;
  status: CheckStatus;
  exitCode?: number;
  output?: string;
  durationMs?: number;
}

/**
 * The structured verdict. Wire-compatible (camelCase) with the Rust
 * `StructureLockResult` — `failedCheck` is omitted when everything passed.
 */
export interface StructureLockResult {
  passed: boolean;
  checks: StructureLockCheck[];
  failedCheck?: string;
}

/** The normalized result of one spawn — a subset of Node's `spawnSync` return. */
export interface SpawnResult {
  /** Process exit code, or `null` when the process did not exit normally. */
  status: number | null;
  /** The signal that terminated the process, if any (e.g. a timeout kill). */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be launched or was timed out. */
  error?: { code?: string; message?: string };
}

/** Runs `program args` in `cwd`, bounded by `timeoutMs`. Must never throw. */
export type SpawnFn = (
  program: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => SpawnResult;

/** How much of a failing check's combined output to keep (mirror `tail_output`). */
const TAIL_LIMIT = 4000;

/**
 * Combine stdout+stderr and keep the last {@link TAIL_LIMIT} characters (the
 * part that usually names the failure), prefixed with `…` when truncated.
 * Mirrors the Rust `tail_output`.
 */
export function tailOutput(stdout: string, stderr: string): string {
  let combined = stdout;
  if (stderr.length > 0) combined += `\n${stderr}`;
  if (combined.length > TAIL_LIMIT) {
    return `…${combined.slice(combined.length - TAIL_LIMIT)}`;
  }
  return combined;
}

/** The human-readable timeout note (mirror `run_check_once`'s timeout arm). */
function timeoutMessage(timeoutMs: number): string {
  return `timed out after ${timeoutMs}ms (the check was killed; it may hang or need a higher timeoutMs)`;
}

interface Interpreted {
  status: CheckStatus;
  exitCode?: number;
  output?: string;
}

/**
 * Turn a raw spawn result into a check outcome. A timeout (an `ETIMEDOUT` error
 * or a non-null signal) or a launch failure is a FAILED check (fail-closed,
 * never a silent pass). Otherwise exit 0 ⇒ passed, any other exit ⇒ failed with
 * the captured output tail.
 */
function interpret(res: SpawnResult, timeoutMs: number): Interpreted {
  const timedOut = res.error?.code === 'ETIMEDOUT' || res.signal != null;
  if (timedOut) {
    return { status: 'failed', output: timeoutMessage(timeoutMs) };
  }
  if (res.error) {
    const detail = res.error.message ?? res.error.code ?? 'unknown error';
    return { status: 'failed', output: `failed to launch: ${detail}` };
  }
  if (res.status === 0) {
    return { status: 'passed', exitCode: 0 };
  }
  return {
    status: 'failed',
    exitCode: res.status ?? undefined,
    output: tailOutput(res.stdout, res.stderr),
  };
}

/** A trivially-passing result (no config / no enabled checks). */
export function emptyPass(): StructureLockResult {
  return { passed: true, checks: [] };
}

/**
 * Run every planned check in `runDir` (full-run), spawning through `spawn`.
 * `onCommand` fires just before each check runs (legibility — the caller echoes
 * the command). A trivially-passing result when `planned` is empty.
 */
export function runChecks(
  planned: PlannedCheck[],
  runDir: string,
  spawn: SpawnFn,
  onCommand?: (check: PlannedCheck) => void,
): StructureLockResult {
  if (planned.length === 0) return emptyPass();

  const checks: StructureLockCheck[] = [];
  let failedCheck: string | undefined;

  for (const check of planned) {
    onCommand?.(check);
    const start = Date.now();
    const res = spawn(check.program, check.args, {
      cwd: runDir,
      timeoutMs: check.timeoutMs,
    });
    const durationMs = Date.now() - start;
    const outcome = interpret(res, check.timeoutMs);

    if (outcome.status === 'failed' && failedCheck === undefined) {
      failedCheck = check.name;
    }

    checks.push({
      name: check.name,
      kind: check.kind,
      command: check.command,
      status: outcome.status,
      exitCode: outcome.exitCode,
      output: outcome.output,
      durationMs,
    });
  }

  const result: StructureLockResult = { passed: failedCheck === undefined, checks };
  if (failedCheck !== undefined) result.failedCheck = failedCheck;
  return result;
}

/**
 * A human-readable instruction listing EVERY failed check (name + exact command
 * + captured output tail), mirroring the Rust `fix_instruction`. In full-run
 * mode the result records the whole failure set, so one read addresses them all.
 */
export function fixInstruction(result: StructureLockResult): string {
  const failed = result.checks.filter((c) => c.status === 'failed');
  if (failed.length === 0) {
    return (
      'The Structure-Lock check failed. Fix the project\'s harness checks ' +
      'before this work can be verified or merged.'
    );
  }

  let out =
    `The Structure-Lock check failed: ${failed.length} project harness ` +
    `check${failed.length === 1 ? '' : 's'} did not pass. They MUST all pass ` +
    'before this work can be verified or merged. Re-run each one locally and ' +
    'fix every violation it reports:';
  for (const c of failed) {
    out +=
      `\n\n--- \`${c.name}\` ---\nCommand: ${c.command}\n\nOutput:\n` +
      `${c.output ?? '(no output captured)'}`;
  }
  return out;
}
