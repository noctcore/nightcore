/**
 * The council run GOVERNOR (issue #350, safety non-negotiable #4: hard budget/round
 * caps + a kill switch — never "run until they agree").
 *
 * One governor per council run owns the two orthogonal ways a run is stopped short of
 * convergence:
 *
 *  - **Hard caps.** Every seat turn is charged here; before each turn the Conductor
 *    asks {@link RunGovernor.capBreached}, which returns the first tripped cap
 *    (`maxTotalTokens` / `maxCostUsd`) — the run then halts `budget-exhausted`. The
 *    round cap is enforced by {@link RunGovernor.roundBudgetRemaining} (the effective
 *    `min` of the preset's Debate `maxRounds` and the budget's `maxRounds`).
 *  - **Kill switch.** {@link RunGovernor.kill} aborts an {@link AbortController} the
 *    Conductor threads into every seat turn AND latches a flag the Conductor checks
 *    between awaited steps — so a kill halts promptly even if a driver ignores the
 *    signal.
 *
 * The caps are read from a preset's {@link CouncilBudget}; the preset validator has
 * already guaranteed they are present + positive, but this class treats a missing cap
 * as `Infinity`-free (it never trusts an absent cap as "unlimited" — it is charged
 * defensively). Pure and deterministic: no clock, no I/O.
 */
import type { CouncilBudget } from '@nightcore/contracts';

import type {
  BudgetHaltCause,
  SeatTurnResult,
  TurnEstimate,
} from './conductor-types.js';

/** The running totals the governor accumulates. */
export interface GovernorTotals {
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly rounds: number;
}

export class RunGovernor {
  private tokens = 0;
  private cost = 0;
  private rounds = 0;
  /** Budget reserved for in-flight (dispatched-but-not-yet-charged) turns, so a
   *  concurrent broadcast's cap check sees turns already committed to. Always net-zero
   *  between broadcasts (every reservation is settled or released). */
  private reservedTokens = 0;
  private reservedCost = 0;
  private readonly controller = new AbortController();
  private killedFlag = false;

  constructor(private readonly budget: CouncilBudget) {}

  /** The abort signal threaded into every seat turn; aborts on {@link kill}. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether the kill switch has been thrown. Checked by the Conductor between steps. */
  get killed(): boolean {
    return this.killedFlag;
  }

  /** The running totals (for the terminal {@link import('./conductor-types.js').CouncilRunResult}). */
  get totals(): GovernorTotals {
    return { totalTokens: this.tokens, costUsd: this.cost, rounds: this.rounds };
  }

  /** Throw the kill switch: latch the flag AND abort the in-flight turn's signal.
   *  Idempotent. */
  kill(): void {
    if (this.killedFlag) return;
    this.killedFlag = true;
    this.controller.abort();
  }

  /** Charge one seat turn's spend against the run. Called after every turn. Every
   *  token field the SDK reported counts toward the total-token ceiling. */
  chargeTurn(result: SeatTurnResult): void {
    const {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningOutputTokens,
    } = result.usage;
    this.tokens +=
      inputTokens +
      outputTokens +
      cacheReadTokens +
      cacheCreationTokens +
      reasoningOutputTokens;
    this.cost += result.costUsd;
  }

  /**
   * Reserve a per-turn estimate BEFORE a seat is dispatched (issue #351, LOW-A). The
   * reservation is gated on the ACCUMULATED committed spend PLUS all reservations
   * already outstanding — so once the caps are reached, no further seat is admitted and
   * a bounded parallel broadcast can overshoot by at most one in-flight estimate, never
   * a whole round. Returns `false` when the cap is already reached (the caller MUST NOT
   * dispatch); `true` when the estimate was reserved.
   */
  tryReserve(estimate: TurnEstimate): boolean {
    if (this.tokens + this.reservedTokens >= this.budget.maxTotalTokens) return false;
    if (this.cost + this.reservedCost >= this.budget.maxCostUsd) return false;
    this.reservedTokens += estimate.tokens;
    this.reservedCost += estimate.costUsd;
    return true;
  }

  /** Settle a reservation once the turn LANDED: drop the estimate and charge the turn's
   *  ACTUAL spend. Net effect on the caps is exactly {@link chargeTurn}. */
  settleReservation(estimate: TurnEstimate, result: SeatTurnResult): void {
    this.releaseReservation(estimate);
    this.chargeTurn(result);
  }

  /** Release a reservation for a turn that never ran (refused, timed-out, or superseded
   *  by quorum) — the estimate is dropped and nothing is charged. */
  releaseReservation(estimate: TurnEstimate): void {
    this.reservedTokens = Math.max(0, this.reservedTokens - estimate.tokens);
    this.reservedCost = Math.max(0, this.reservedCost - estimate.costUsd);
  }

  /** Record that a full debate round completed (for the round cap + telemetry). */
  countRound(): void {
    this.rounds += 1;
  }

  /**
   * The first hard cap the ACCUMULATED spend has breached, or `null` if within
   * budget. Checked before each turn so a run halts AT the cap, never past a run that
   * would exceed it. `maxRounds` is NOT checked here — rounds are bounded structurally
   * by {@link roundBudgetRemaining}; this guards the token/cost ceilings.
   */
  capBreached(): BudgetHaltCause | null {
    if (this.tokens >= this.budget.maxTotalTokens) return 'maxTotalTokens';
    if (this.cost >= this.budget.maxCostUsd) return 'maxCostUsd';
    return null;
  }

  /**
   * How many more debate rounds this run may execute, given a Debate stage's own
   * `maxRounds` (`≤2` in P1). The effective cap is the MIN of the stage cap and the
   * budget's absolute `maxRounds` (the whole-run backstop), minus rounds already run.
   * Never negative.
   */
  roundBudgetRemaining(stageMaxRounds: number): number {
    const effective = Math.min(stageMaxRounds, this.budget.maxRounds);
    return Math.max(0, effective - this.rounds);
  }
}
