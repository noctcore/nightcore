/**
 * Run-lifecycle primitives shared across the scan siblings (Insight / Harness /
 * Scorecard / Issue Triage / PR-Review): the live lifecycle phase, the token-usage
 * accumulator, and the per-step progress map. Re-exported from the `@/lib/scan-run`
 * barrel — see that module for why these cross-family helpers live in `lib/`.
 */

/**
 * The lifecycle screen a scan view renders. Structurally identical to the shell's
 * `RunPhase` (`@/components/ui`), re-declared here so `lib/` stays below the
 * component layer — a value of this type assigns freely to a `RunPhase` field.
 */
export type ScanViewPhase = 'configure' | 'running' | 'results';

/**
 * Derive the active lifecycle screen from the live stream status and the two view
 * flags. Cloned byte-for-byte across all four scan `*View.hooks.ts`: `isStarting`
 * folds the optimistic-launch IPC gap into RUNNING (the persisted `status` is
 * still the prior run's `completed` until the optimistic running stream lands, so
 * without it a "New run" would flash the previous RESULTS); `reconfiguring` is the
 * explicit "New run" override that returns a completed run to CONFIGURE.
 */
export function deriveRunPhase(
  status: string,
  isStarting: boolean,
  reconfiguring: boolean,
): ScanViewPhase {
  if (status === 'running' || isStarting) return 'running';
  if (reconfiguring || status === 'idle') return 'configure';
  return 'results';
}

/** The token-usage accumulator every scan stream carries (input/output tokens). */
export interface ScanUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Accumulate a per-step usage delta into a running total. A missing delta
 * (`undefined`) leaves the total untouched. This was cloned verbatim in all four
 * `*-stream.ts` reducers — it is the token-accounting primitive the fold uses on
 * every `*-category-completed` / `*-dimension-completed` / `*-lens-completed` event.
 */
export function addUsage(a: ScanUsage, b: ScanUsage | undefined): ScanUsage {
  if (b === undefined) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/**
 * The per-step (category / dimension / lens) progress a scan tracks while it runs.
 * Every family re-declares this same four-value union under its own noun
 * (`CategoryProgress` / `DimensionProgress` / `LensProgress`); they are structurally
 * identical and interchange freely with this canonical name.
 */
export type ScanStepProgress = 'pending' | 'running' | 'done' | 'error';

/**
 * Project a persisted run's status string onto the terminal view status. The
 * persisted enum only ever reloads as running / failed / <else = completed>; the
 * `idle` state is live-only, so it never appears here. Cloned verbatim in all four
 * `streamFromRun` projectors.
 */
export function runStatusFromPersisted(
  status: string,
): 'running' | 'failed' | 'completed' {
  return status === 'running'
    ? 'running'
    : status === 'failed'
      ? 'failed'
      : 'completed';
}

/**
 * Seed a fresh step-state map with every requested step `pending`. Used on the
 * `*-started` event to lay out the stepper before any step reports in.
 */
export function seedStepState(
  steps: readonly string[],
): Record<string, ScanStepProgress> {
  return Object.fromEntries(steps.map((s) => [s, 'pending' as ScanStepProgress]));
}

/**
 * Seed a step-state map from a reloaded persisted run: `pending` while the run is
 * still mid-flight (`running === true`), else all `done`. A persisted run carries
 * no per-step completion, so an in-flight reload can only show the stepper as
 * uniformly pending.
 */
export function seedStepStateFromRun(
  steps: readonly string[],
  running: boolean,
): Record<string, ScanStepProgress> {
  return Object.fromEntries(
    steps.map((s) => [s, running ? 'pending' : 'done'] as const),
  );
}

/**
 * Settle every requested step to its terminal state on the `*-completed` event:
 * a step that errored stays `error`, everything else becomes `done`. Cloned
 * verbatim in all four terminal-event folds.
 */
export function settleStepState(
  requested: readonly string[],
  prev: Record<string, ScanStepProgress>,
): Record<string, ScanStepProgress> {
  return Object.fromEntries(
    requested.map((s) => [s, prev[s] === 'error' ? 'error' : 'done'] as const),
  );
}
