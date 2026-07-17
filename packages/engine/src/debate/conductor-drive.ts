/**
 * The Council CONDUCTOR's STAGE SEQUENCER (issue #350) — the Frame → Propose → Debate →
 * [Build] → Converge drive loop, split out of `conductor.ts` so the class stays a thin
 * lifecycle surface (start/kill/route/resolve) under the engine file-size cap.
 *
 * These are free functions, not methods: `driveCouncil` takes the run's already-assembled
 * collaborators (the observer-wrapped bus, the governor, the seats, the live routing
 * policy, the parked-decision map) plus the {@link ConductorDeps} and runs the state
 * machine to a terminal {@link CouncilRunResult}. The per-stage work still lives in the
 * sibling stage modules (`conductor-propose.ts`, `debate-round.ts`, `conductor-build.ts`,
 * `conductor-converge.ts`, `conductor-autoconverge.ts`); this module only owns the
 * SEQUENCE + the between-stage kill/budget checks, so the whole flow + its safety
 * invariants stay drivable with deterministic fake seats — no live provider call.
 */
import type { DebateStage } from '@nightcore/contracts';

import type { ConductorBus } from './bus.js';
import type { ConductorDeps, CouncilRunInput } from './conductor.js';
import { runAutonomousConverge } from './conductor-autoconverge.js';
import type { RunGovernor } from './conductor-budget.js';
import { runBuild } from './conductor-build.js';
import { type ParkedConverge, runConverge } from './conductor-converge.js';
import { debateMaxRounds, stageDispatchConfig } from './conductor-dispatch.js';
import { debatePrompt, proposePrompt } from './conductor-prompts.js';
import { runProposeStage } from './conductor-propose.js';
import { runReview } from './conductor-review.js';
import type {
  BudgetHaltCause,
  CouncilRunResult,
  CouncilRunStatus,
  SeatContext,
  SeatTurnResult,
} from './conductor-types.js';
import type { RoutingPolicy } from './council-routing.js';
import { runDebateRounds } from './debate-round.js';
import { objectiveGateForPreset } from './objective-preset.js';
import { debatingSeats, judgeSeat } from './preset-validator.js';

/** The terminal status the governor implies after a stage, or null to continue.
 *  Separates a kill from a specific budget cap. */
export function governorStatus(
  governor: RunGovernor,
): { status: CouncilRunStatus; haltedBy?: BudgetHaltCause } | null {
  if (governor.killed) return { status: 'killed' };
  const cause = governor.capBreached();
  if (cause !== null) return { status: 'budget-exhausted', haltedBy: cause };
  return null;
}

/** Assemble a terminal {@link CouncilRunResult} from the run's transcript + totals. */
export function buildResult(
  deps: ConductorDeps,
  councilRunId: string,
  status: CouncilRunStatus,
  governor: RunGovernor,
  haltedBy?: BudgetHaltCause,
): CouncilRunResult {
  return {
    councilRunId,
    status,
    transcript: deps.bus.seatView(councilRunId, 'conductor').read(),
    usage: governor.totals,
    ...(haltedBy !== undefined ? { haltedBy } : {}),
  };
}

/** Drive one seat turn through the {@link import('./conductor-types.js').SeatDriver}
 *  seam, threading the collector's per-seat abort `signal` (kill/budget OR the collector's
 *  own timeout / quorum cutoff) so the driver can bail on any of them. */
export function runSeatTurn(
  deps: ConductorDeps,
  input: CouncilRunInput,
  seat: SeatContext,
  stage: DebateStage,
  prompt: string,
  signal: AbortSignal,
): Promise<SeatTurnResult> {
  return deps.seatDriver.runTurn({
    seat,
    stage,
    prompt,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    signal,
  });
}

/** The Frame → Propose → Debate → [Build] → Converge sequence for a validated preset. */
export async function driveCouncil(
  deps: ConductorDeps,
  input: CouncilRunInput,
  bus: ConductorBus,
  governor: RunGovernor,
  seats: SeatContext[],
  routing: RoutingPolicy,
  parked: Map<string, ParkedConverge>,
): Promise<CouncilRunResult> {
  const { councilRunId, preset, objective } = input;

  // The DEDICATED judge seat (issue #370) does not debate — it rules at Converge for a
  // `judge-agent` preset. Propose/Debate/vote run over the debating (non-judge) seats;
  // for a `human`/`vote` preset there is no judge seat, so `debaters` is every seat
  // (P1 behaviour unchanged).
  const debaters = debatingSeats(seats);
  const judge = judgeSeat(seats);

  // The Converge gate, resolved PER-PRESET (issue #367, safety #6): an OBJECTIVE preset
  // (e.g. the UI-bug preset's `repro` gate) builds its gate from the preset marker + the
  // injected gauntlet runner, so `research` on the SAME CouncilManager stays gate-less. A
  // preset-resolved gate takes precedence; otherwise the fixed `deps.objectiveGate` (used by
  // the unit/safety tests) applies. Reuses the gauntlet exec — no new sink.
  const gate =
    objectiveGateForPreset(preset, deps.gauntletRunner) ?? deps.objectiveGate;

  bus.note(
    'frame',
    `Council "${preset.label}" framed. Objective: ${objective}. ` +
      `Success criterion: ${preset.successCriterion}.`,
  );

  // ── Propose (BLIND, parallel): no peer content enters a Propose prompt. ─────
  const proposeOutputs = await runProposeStage({
    bus,
    seats: debaters,
    governor,
    dispatch: stageDispatchConfig(preset, debaters, deps),
    buildPrompt: (seat) => proposePrompt(objective, seat),
    runTurn: (seat, prompt, signal) =>
      runSeatTurn(deps, input, seat, 'propose', prompt, signal),
  });
  const proposeHalt = governorStatus(governor);
  if (proposeHalt !== null) {
    return buildResult(deps, councilRunId, proposeHalt.status, governor, proposeHalt.haltedBy);
  }

  // ── Debate (≤2 rounds, early-stop on stability). ───────────────────────────
  const debate = await runDebateRounds({
    bus,
    seats: debaters,
    governor,
    stageMaxRounds: debateMaxRounds(preset),
    priorOutputs: proposeOutputs,
    dispatch: stageDispatchConfig(preset, debaters, deps),
    // The editable routing filter (issue #371), read FRESH each round so a live rewire
    // applies on the next round. It only narrows which mediated peers a seat hears.
    informers: (toSeatId) => routing.informers(toSeatId),
    // The #372 no-progress stall stop (a strict shortener; absent ⇒ default rounds).
    ...(deps.noProgressRounds !== undefined ? { noProgressRounds: deps.noProgressRounds } : {}),
    buildPrompt: (seat, round, peerText) =>
      debatePrompt(objective, seat, round, peerText),
    runTurn: (seat, prompt, signal) =>
      runSeatTurn(deps, input, seat, 'debate', prompt, signal),
  });
  if (debate.halt !== null) {
    const status: CouncilRunStatus =
      debate.halt.kind === 'killed' ? 'killed' : 'budget-exhausted';
    return buildResult(deps, councilRunId, status, governor, debate.halt.cause);
  }

  // ── Build (SINGLE writer, isolated worktree — issue #366, safety #5). DORMANT
  // unless the preset declares a `build` stage AND a buildDriver is injected; then
  // ONE elected writer executes the plan write-capable-but-sandboxed and the
  // objective gate below judges the BUILD OUTPUT. ─────────────────────────────
  const buildOutcome = await runBuild({
    bus,
    driver: deps.buildDriver,
    preset,
    run: input,
    seats,
    finalOutputs: debate.finalOutputs,
    governor,
    logger: deps.logger,
  });
  const buildHalt = governorStatus(governor);
  if (buildHalt !== null) {
    return buildResult(deps, councilRunId, buildHalt.status, governor, buildHalt.haltedBy);
  }

  // ── Review (ADVERSARIAL — issue #369, safety #2/#6/#7). DORMANT unless the preset
  // declares a `review` stage AND a reviewDriver is injected AND a Build produced a diff;
  // then a SEPARATE reviewer independently critiques the writer's diff (reusing the PR
  // phase-4 diff reviewer). Its verdict is ADVISORY scanned+quoted DATA recorded through the
  // mediated bus — the objective gate still OUTRANKS it (a passing Review can't relax a red
  // gate) and the human is terminal; it never gates acceptance. ────────────────────────
  const reviewVerdict = await runReview({
    bus,
    driver: deps.reviewDriver,
    preset,
    run: input,
    build: buildOutcome,
    governor,
    logger: deps.logger,
  });
  const reviewHalt = governorStatus(governor);
  if (reviewHalt !== null) {
    return buildResult(deps, councilRunId, reviewHalt.status, governor, reviewHalt.haltedBy);
  }

  // ── Converge: run the OBJECTIVE GATE (safety #6; a red verdict overrides
  // consensus) — over the BUILD OUTPUT when a build ran — then park the debaters'
  // positions for the human judge (non-human convergence may auto-adopt, #370). The
  // adversarial Review verdict rides the parked decision as advisory data (#369). ─
  const pending = await runConverge({
    parked,
    bus,
    gate,
    run: input,
    seats: debaters,
    finalOutputs: debate.finalOutputs,
    rounds: governor.totals.rounds,
    signal: governor.signal,
    logger: deps.logger,
    ...(buildOutcome !== null ? { buildOutput: buildOutcome } : {}),
    ...(reviewVerdict !== null ? { reviewVerdict } : {}),
  });

  // ── Non-human convergence (issue #370): a judge-agent rules or the seats vote.
  // The objective gate still OUTRANKS the mode (a red gate parks for the human) and
  // an auto-adopt is a conductor note, never a forged human verdict. Skipped when a
  // budget cap tripped during Converge's gate so the human decides. ──────────────
  if (preset.convergence !== 'human' && governorStatus(governor) === null) {
    await runAutonomousConverge({
      convergence: preset.convergence,
      parked,
      bus,
      pending,
      objective,
      judgeSeat: judge,
      voterSeats: debaters,
      governor,
      dispatch: stageDispatchConfig(preset, debaters, deps),
      runTurn: (seat, prompt, signal) =>
        runSeatTurn(deps, input, seat, 'converge', prompt, signal),
      signal: governor.signal,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    });
  }

  return { ...buildResult(deps, councilRunId, 'converged', governor), pendingDecision: pending };
}
