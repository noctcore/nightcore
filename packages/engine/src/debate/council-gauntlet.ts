/**
 * The production Council objective-gate {@link GauntletRunner} (issue #383) — the exec the
 * `repro` / `build` gates reuse at Converge (safety non-negotiable #6). It is deliberately
 * a THIN adapter over the path-less {@link WorktreeOpBroker}: it issues ONE `gauntlet`
 * worktree op keyed on the run's `councilRunId` and maps the host's reply into the {@link
 * GauntletLikeResult} `objectiveGateForPreset` → {@link gauntletObjectiveGate} expects.
 *
 * NO new exec sink is introduced in the engine. The Structure-Lock gauntlet runs on the
 * RUST host, reusing the board's already-audited runner (`crate::gauntlet_project::run_from`):
 * the host loads the manifest from the TRUSTED project root and runs the checks in the
 * run's worktree — BOTH paths derived host-side from the `councilRunId`, never sent by the
 * engine. That closes the writer-tampered-manifest vector (a write-capable writer cannot
 * redefine which checks run) exactly as the board's worktree gate does.
 *
 * FAIL-CLOSED: a gate that could not run (a killed/budget-halted run, a host error) is RED,
 * never a silent pass — a failing/absent objective check must OVERRIDE debate consensus.
 */
import type {
  GauntletLikeResult,
  GauntletRunner,
  ObjectiveGateContext,
} from './objective-gate.js';
import type { WorktreeOpBroker } from './worktree-rpc.js';

/** The synthetic check name the host's aggregate Structure-Lock verdict maps to (the host
 *  runs the whole gauntlet and returns a single pass/fail + summary). */
const STRUCTURE_LOCK_CHECK = 'structure-lock';

/**
 * Build the {@link GauntletRunner} a build-capable Council's Converge gate runs. It reaches
 * the Rust host's Structure-Lock gauntlet over `broker` — the SAME path-less,
 * `councilRunId`-keyed seam the build driver allocates/commits through — so the engine
 * never handles a worktree path for the gate either.
 */
export function createCouncilGauntletRunner(broker: WorktreeOpBroker): GauntletRunner {
  return async (context: ObjectiveGateContext): Promise<GauntletLikeResult> => {
    const reply = await broker.request('gauntlet', context.councilRunId, context.signal);

    // FAIL-CLOSED (safety #6): the gate could not produce a verdict ⇒ RED. A killed run,
    // a budget halt, or a host error must never be read as a green gate.
    if (reply.error !== undefined || reply.gauntletPassed === undefined) {
      const detail =
        reply.error ?? reply.gauntletSummary ?? 'the Structure-Lock gauntlet could not run';
      return {
        passed: false,
        failedCheck: STRUCTURE_LOCK_CHECK,
        checks: [{ name: STRUCTURE_LOCK_CHECK, status: 'failed', output: detail }],
      };
    }

    const summary =
      reply.gauntletSummary ??
      (reply.gauntletPassed
        ? 'Structure-Lock gauntlet passed.'
        : 'Structure-Lock gauntlet FAILED.');
    return {
      passed: reply.gauntletPassed,
      checks: [
        {
          name: STRUCTURE_LOCK_CHECK,
          status: reply.gauntletPassed ? 'passed' : 'failed',
          output: summary,
        },
      ],
      ...(reply.gauntletPassed ? {} : { failedCheck: STRUCTURE_LOCK_CHECK }),
    };
  };
}
