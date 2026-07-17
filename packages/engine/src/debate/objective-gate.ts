/**
 * The Council OBJECTIVE GATE (issue #365, P2 FOUNDATION — safety non-negotiable #6:
 * objective gates outrank debate).
 *
 * An objective gate runs a DETERMINISTIC check — the pre-merge Structure-Lock gauntlet,
 * a bug repro command, or a build — and returns a plain pass/fail {@link
 * ObjectiveGateVerdict}. Its whole purpose is to be the terminal judge for an objective
 * task: a RED verdict OVERRIDES whatever the seats concluded, so a confident-but-wrong
 * debate consensus cannot be adopted over a failing test/repro/build. The human remains
 * the ultimate authority and can override the gate deliberately (see the Conductor's
 * Converge resolution), but the DEFAULT terminal judgment for an objective task is the
 * gate's, not the debate's.
 *
 * The seam is deliberately EXEC-AGNOSTIC, mirroring {@link
 * import('./conductor-types.js').SeatDriver}: the engine NEVER spawns a process here. A
 * gate is `context → verdict`; how the verdict is produced (an injected gauntlet runner,
 * a fake in tests) lives behind the seam. That keeps the Conductor's override wiring +
 * its safety test drivable with a deterministic fake gate — no live exec — while the
 * production gate REUSES the existing gauntlet machinery ({@link gauntletObjectiveGate},
 * wired to the harness `runChecks`) rather than inventing a new exec sink.
 */
import type { DebateSeatRole } from '@nightcore/contracts';

/** One seat's final position handed to a gate — the shape the Conductor carries into
 *  Converge. Structurally identical to {@link
 *  import('./conductor-types.js').SeatPosition}; declared here so this module has NO
 *  dependency on the conductor types (a gate is a leaf the conductor consumes). */
export interface ObjectiveGatePosition {
  readonly seatId: string;
  readonly role: DebateSeatRole;
  readonly content: string;
}

/** One check the gate ran, mapped to a pass/fail with an optional detail (the failing
 *  command's captured output tail). */
export interface ObjectiveGateCheck {
  readonly name: string;
  readonly passed: boolean;
  /** The check's captured detail (a failure's output tail), when present. */
  readonly detail?: string;
}

/**
 * The deterministic pass/fail a gate produces. `passed` is the ONLY thing that decides
 * the override — `summary` (and the optional per-check breakdown) is the auditable
 * reason recorded onto the transcript and surfaced to the human judge.
 */
export interface ObjectiveGateVerdict {
  /** Whether the objective check passed. A `false` OVERRIDES debate consensus. */
  readonly passed: boolean;
  /** A human-readable one-line reason (the failing check / repro status / build error). */
  readonly summary: string;
  /** The individual check outcomes, when the gate ran a multi-check gauntlet. */
  readonly checks?: readonly ObjectiveGateCheck[];
}

/** What the Conductor hands a gate at Converge. The gate reads it to run the objective
 *  check for THIS run — the working dir the check executes in, the seats' final
 *  positions (for a plan/repro-derived gate), and the run's abort signal. */
export interface ObjectiveGateContext {
  readonly councilRunId: string;
  readonly objective: string;
  readonly successCriterion: string;
  /** The working directory the deterministic check runs in. Absent ⇒ the process cwd. */
  readonly cwd?: string;
  /** The seats' final positions entering Converge (side-by-side; disagreement intact). */
  readonly positions: readonly ObjectiveGatePosition[];
  /** Aborts when the run is killed or the budget is exhausted mid-check. */
  readonly signal: AbortSignal;
}

/**
 * The provider/exec-neutral seam the Conductor runs at Converge. ONE method: run a
 * deterministic objective check and return its verdict. Fakes implement it for the
 * override + safety tests; {@link gauntletObjectiveGate} implements it over the real
 * pre-merge gauntlet.
 */
export interface ObjectiveGate {
  evaluate(context: ObjectiveGateContext): Promise<ObjectiveGateVerdict>;
}

/**
 * The subset of a Structure-Lock gauntlet result a gate maps to a verdict — structurally
 * compatible with the harness runner's `StructureLockResult`
 * (`packages/harness/src/run.ts`). A production gate injects that runner (its `runChecks`
 * bound to the run's worktree + a spawn) as {@link gauntletObjectiveGate}'s `runGauntlet`
 * and reuses the existing pre-merge gauntlet; the engine never spawns.
 */
export interface GauntletLikeResult {
  readonly passed: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly status: 'passed' | 'failed';
    readonly output?: string;
  }[];
  /** The FIRST failed check's name, when any check failed. */
  readonly failedCheck?: string;
}

/**
 * The INJECTED gauntlet runner a production gate reuses: `context → gauntlet result`. In
 * production it is the harness `runChecks` bound to the run's worktree + a spawn (the
 * gauntlet's OWN exec sink — never a new one); in tests a deterministic fake. Named so the
 * preset-aware gate resolver (`objective-preset.ts`) and the Conductor can thread it
 * without re-typing the closure.
 */
export type GauntletRunner = (
  context: ObjectiveGateContext,
) => GauntletLikeResult | Promise<GauntletLikeResult>;

/**
 * Build an {@link ObjectiveGate} that runs a deterministic Structure-Lock gauntlet and
 * maps its result to a verdict. `runGauntlet` is the INJECTED gauntlet runner — in
 * production the harness `runChecks` bound to the run's worktree + a spawn; in tests a
 * deterministic fake. This is how the gate REUSES the existing gauntlet machinery
 * instead of inventing a new exec sink: the exec belongs to the gauntlet, this only
 * adapts its shape.
 */
export function gauntletObjectiveGate(runGauntlet: GauntletRunner): ObjectiveGate {
  return {
    async evaluate(context) {
      const result = await runGauntlet(context);
      const checks: ObjectiveGateCheck[] = result.checks.map((check) => ({
        name: check.name,
        passed: check.status === 'passed',
        ...(check.output !== undefined ? { detail: check.output } : {}),
      }));
      const summary = result.passed
        ? `Structure-Lock gauntlet passed (${checks.length} check(s)).`
        : `Structure-Lock gauntlet FAILED` +
          (result.failedCheck !== undefined
            ? ` at "${result.failedCheck}".`
            : ` (${checks.filter((c) => !c.passed).length} check(s) red).`);
      return { passed: result.passed, summary, checks };
    },
  };
}
