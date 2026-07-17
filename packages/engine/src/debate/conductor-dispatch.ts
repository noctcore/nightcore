/**
 * The Conductor's broadcast-DISPATCH sizing (issue #350) — pure functions split out of
 * `conductor.ts` so the state machine stays under the engine file-size cap, alongside the
 * other `conductor-*` helper modules (`conductor-converge.ts`, `conductor-routing.ts`).
 *
 * Propose and each Debate round dispatch through the SAME broadcast collector, so their
 * bounded-concurrency, per-seat-timeout, and per-turn budget-reservation knobs are
 * single-sourced here. Keeping these pure (no bus, no `this`) makes the sizing math
 * unit-testable in isolation and keeps the Conductor focused on the state machine.
 */
import type { CouncilPreset } from '@nightcore/contracts';

import type { SeatContext, TurnEstimate } from './conductor-types.js';

/** The collector limits the Conductor is configured with (from its deps). */
export interface DispatchLimits {
  readonly maxSeatConcurrency?: number;
  readonly seatTimeoutMs?: number;
}

/** The per-stage broadcast-collector config: bounded concurrency + per-seat timeout +
 *  the per-turn budget reservation. */
export interface StageDispatchConfig {
  maxConcurrency?: number;
  timeoutMs?: number;
  estimate: TurnEstimate;
}

/** The Debate stage's `maxRounds` from the preset (`≤2`); defaults to 1 if the preset
 *  declares a Debate step with no cap, or 0 if it declares none. */
export function debateMaxRounds(preset: CouncilPreset): number {
  const debate = preset.stages.find((step) => step.stage === 'debate');
  return debate?.maxRounds ?? (debate !== undefined ? 1 : 0);
}

/** A conservative per-turn budget estimate the collector RESERVES before dispatch (#351,
 *  LOW-A): each turn's fair share of the run budget over every turn the run may take
 *  (`seats × (1 Propose + Debate maxRounds)`). Under-estimates settle down and free
 *  headroom; over-estimates are caught by the post-stage cap check. This bounds a parallel
 *  broadcast's overshoot to at most one in-flight estimate, never a whole round. */
export function turnEstimate(
  preset: CouncilPreset,
  seats: readonly SeatContext[],
): TurnEstimate {
  const plannedTurns = Math.max(1, seats.length * (1 + debateMaxRounds(preset)));
  return {
    tokens: Math.ceil(preset.budget.maxTotalTokens / plannedTurns),
    costUsd: preset.budget.maxCostUsd / plannedTurns,
  };
}

/** The broadcast-collector knobs shared by Propose + Debate: bounded concurrency, the
 *  per-seat timeout, and the per-turn budget reservation (LOW-A). Both stages dispatch
 *  through the same collector, so their concurrency + overshoot bounds are identical. */
export function stageDispatchConfig(
  preset: CouncilPreset,
  seats: readonly SeatContext[],
  limits: DispatchLimits,
): StageDispatchConfig {
  return {
    ...(limits.maxSeatConcurrency !== undefined
      ? { maxConcurrency: limits.maxSeatConcurrency }
      : {}),
    ...(limits.seatTimeoutMs !== undefined
      ? { timeoutMs: limits.seatTimeoutMs }
      : {}),
    estimate: turnEstimate(preset, seats),
  };
}
