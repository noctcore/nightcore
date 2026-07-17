/**
 * The Council BUILD stage orchestration (issue #366, P2 — safety non-negotiable #5:
 * single-writer builds on isolated worktrees). Split out of `conductor.ts` so the state
 * machine stays under the engine file-size cap, mirroring `conductor-converge.ts`.
 *
 * Build slots between Debate and the human Converge: after the debate converges on a plan,
 * the Conductor ELECTS exactly one writer (safety #1 — conductor-mediated, never
 * self-appointed), hands it the converged plan as MEDIATED quoted+scanned data (safety #2
 * — even the plan the writer implements is injection-scanned, never a raw instruction),
 * and drives its SINGLE write-capable-but-sandboxed turn on an ISOLATED worktree through
 * the exec-neutral {@link BuildDriver} seam (safety #5 + #3). The writer's diff summary is
 * recorded onto the append-only transcript through the mediated bus (safety #7 — never a
 * direct store write). The objective gate (#365, safety #6) then runs its deterministic
 * build/test check on the BUILD OUTPUT (the worktree) at Converge and can REJECT it.
 *
 * The stage is DOUBLE-GATED off by default: it runs ONLY when the preset declares a
 * `build` stage AND a {@link BuildDriver} is injected. Production injects neither today
 * (the Build-capable presets are #367/#368), so the whole stage stays dormant.
 */
import type { CouncilPreset } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { type BuildDriver, electWriter } from './build-writer.js';
import type { ConductorBus } from './bus.js';
// Type-only import (erased at runtime — no import cycle): the Build orchestration consumes
// the run inputs the Conductor already assembled.
import type { CouncilRunInput } from './conductor.js';
import type { RunGovernor } from './conductor-budget.js';
import type { SeatContext } from './conductor-types.js';
import { assemblePeerContext, type PeerOutput } from './peer-context.js';
import { debatingSeats } from './preset-validator.js';

/**
 * The recipient id the converged plan is assembled FOR (safety #2). It is deliberately a
 * NON-SEAT sentinel, not the writer's id: {@link assemblePeerContext} excludes the
 * recipient's own text, but the writer runs as a FRESH session with no memory of its own
 * earlier turns, so it must receive EVERY converged position (its own included) as quoted,
 * injection-scanned data. A sentinel recipient means nothing is filtered out.
 */
const BUILD_PLAN_RECIPIENT = '__council_build_plan__';

/**
 * The outcome of the Build stage — the elected writer, the worktree the objective gate
 * runs on, and the recorded diff summary. `null` from {@link runBuild} means no build ran
 * (dormant: no build stage / no driver / an already-halted run / an empty council with no
 * electable writer).
 */
export interface BuildOutcome {
  readonly writerSeatId: string;
  /** The isolated worktree the writer built in — the objective gate's cwd (safety #6). */
  readonly worktreePath?: string;
  readonly diffSummary: string;
}

/** Inputs for {@link runBuild}. */
export interface RunBuildInput {
  /** The run's OBSERVER-wrapped bus — the writer's diff summary fans out over `nc:debate`. */
  readonly bus: ConductorBus;
  /** The single-writer Build driver. Absent ⇒ the stage is DORMANT (returns null). */
  readonly driver: BuildDriver | undefined;
  readonly preset: CouncilPreset;
  /** The run's inputs (councilRunId / objective / cwd). */
  readonly run: CouncilRunInput;
  readonly seats: readonly SeatContext[];
  /** The debate's final positions (the converged plan), keyed by seat id. */
  readonly finalOutputs: ReadonlyMap<string, string>;
  readonly governor: RunGovernor;
  readonly logger: Logger | undefined;
}

/** Whether a preset declares a `build` stage (the first of the two dormancy gates). */
export function presetHasBuildStage(preset: CouncilPreset): boolean {
  return preset.stages.some((step) => step.stage === 'build');
}

/**
 * Run the Build stage (issue #366). Returns the {@link BuildOutcome}, or `null` when no
 * build ran. Elects the SINGLE writer, delivers the converged plan as mediated
 * quoted+scanned data, drives the writer's one write-capable-but-sandboxed turn on an
 * isolated worktree through the exec-neutral {@link BuildDriver}, charges its spend against
 * the run budget, and records the diff summary onto the append-only transcript through the
 * mediated bus. The worktree it returns becomes the objective gate's cwd at Converge.
 */
export async function runBuild(
  input: RunBuildInput,
): Promise<BuildOutcome | null> {
  // DOUBLE GATE (off by default): a build runs only when the preset declares a `build`
  // stage AND a driver is injected. Production wires neither yet (#367/#368).
  if (input.driver === undefined || !presetHasBuildStage(input.preset)) return null;
  // Never start a write turn on an already-halted run (killed or at a hard cap, safety #4).
  if (input.governor.killed || input.governor.capBreached() !== null) return null;

  // Elect the writer from the DEBATERS only — never a dedicated `judge` seat (#380 gate
  // carry-forward). A judge rules on the debate at Converge; it must not also author the
  // code it will (via the gate) judge. This preset (#367) has no judge seat, so this is a
  // no-op here, but it keeps the SHARED Build path safe for a future preset (#368) that
  // pairs a `build` stage with a `judge-agent` convergence — the writer is a debater, always.
  const writer = electWriter(debatingSeats(input.seats));
  if (writer === null) return null;

  input.bus.note(
    'build',
    `Build stage: elected single writer "${writer.seatId}" (${writer.role}) — the only ` +
      `session permitted to write, on an isolated worktree (safety #5).`,
  );

  // The plan the writer implements is the debated positions, delivered through the SAME
  // mediated, quoted, injection-scanned path every cross-seat relay uses (safety #2): the
  // writer receives the plan as fenced UNTRUSTED data, never a raw instruction, and the
  // scan result is recorded on the transcript.
  const positions: PeerOutput[] = input.seats.map((seat) => ({
    seatId: seat.seatId,
    role: seat.role,
    content: input.finalOutputs.get(seat.seatId) ?? '',
  }));
  const plan = assemblePeerContext(
    input.bus,
    'build',
    BUILD_PLAN_RECIPIENT,
    positions,
  );

  const result = await input.driver.build({
    councilRunId: input.run.councilRunId,
    objective: input.run.objective,
    writer,
    plan: plan.text,
    ...(input.run.cwd !== undefined ? { cwd: input.run.cwd } : {}),
    signal: input.governor.signal,
  });
  input.governor.chargeTurn(result);

  const diffSummary = result.content.trim() || '(no changes reported)';
  input.bus.note(
    'build',
    `Writer "${writer.seatId}" built on ` +
      `${result.worktreePath !== undefined ? `worktree ${result.worktreePath}` : 'its worktree'}. ` +
      `Diff summary: ${diffSummary}`,
  );
  input.logger?.info('council build stage completed', {
    councilRunId: input.run.councilRunId,
    writerSeatId: writer.seatId,
    hasWorktree: result.worktreePath !== undefined,
  });

  return {
    writerSeatId: writer.seatId,
    ...(result.worktreePath !== undefined
      ? { worktreePath: result.worktreePath }
      : {}),
    diffSummary,
  };
}
