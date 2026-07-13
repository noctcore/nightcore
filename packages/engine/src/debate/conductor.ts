/**
 * The Council CONDUCTOR (issue #350) — the stage/turn state machine that owns
 * turn-taking, routing, and convergence for one council run.
 *
 * It is an ORCHESTRATOR, never a peer. It holds the sole {@link ConductorBus} write
 * handle and drives seats through the narrow {@link SeatDriver} seam; a seat is only
 * ever handed a READ-ONLY view and is never given write authority (safety #1 — the
 * injection firewall). Every cross-seat text is routed through the mediated,
 * quoted, injection-scanned delivery path (`peer-context.ts` →
 * {@link ConductorBus.deliverBetweenSeats}); a seat prompt is NEVER built from raw
 * transcript content (carry-forward guard MEDIUM).
 *
 * The state machine (not free chat):
 *
 *   Frame → Propose (blind, parallel) → Debate (≤2 rounds, early-stop) → Converge (HUMAN)
 *
 *  - **Frame**: reject an invalid preset up front (`validateCouncilPreset`), else seed
 *    the run (a frame note + a broadcast of the objective).
 *  - **Propose** (BLIND, parallel): each seat proposes from the objective ALONE — no
 *    peer content enters a Propose prompt, so diversity survives into Debate.
 *  - **Debate** (`≤2` rounds): seats react to peers' prior outputs, but ONLY via the
 *    mediated quoted path; early-stop when positions stabilize (`debate-round.ts`).
 *  - **Converge**: HUMAN judge only in P1 — the Conductor parks the seats' final
 *    positions for a human to accept/reject (safety #7). No agent-judge, no vote.
 *
 * Hard budget/round caps + a kill switch are enforced throughout by a per-run
 * {@link RunGovernor} (safety #4). The whole machine + its safety invariants are
 * driven by deterministic fake seats in the tests — no live provider call.
 */
import type {
  CouncilPreset,
  DebateStage,
  DebateTranscriptEntry,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { collectBroadcast } from './broadcast-collector.js';
import type { ConductorBus, DebateBus } from './bus.js';
import { RunGovernor } from './conductor-budget.js';
import { observeBus } from './conductor-observer.js';
import { debatePrompt, proposePrompt } from './conductor-prompts.js';
import type {
  BudgetHaltCause,
  CouncilRunResult,
  CouncilRunStatus,
  SeatContext,
  SeatDriver,
  SeatPosition,
  SeatTurnResult,
  TurnEstimate,
} from './conductor-types.js';
import { runDebateRounds } from './debate-round.js';
import { validateCouncilPreset } from './preset-validator.js';

export interface ConductorDeps {
  /** The debate bus (owns the append-only transcript store). A fresh bus per run
   *  keeps runs isolated; a shared bus is fine (the store is run-keyed). */
  readonly bus: DebateBus;
  /** The provider-neutral seat driver (fake in tests; session-backed in production). */
  readonly seatDriver: SeatDriver;
  readonly logger?: Logger;
  /** Observe every transcript entry as it is appended — the single emit chokepoint the
   *  `nc:debate` stream wires here in the canvas slice (#352). Default: no-op. */
  readonly onEntry?: (entry: DebateTranscriptEntry) => void;
  /** Max seats the broadcast collector dispatches at once (bounded concurrency, #351).
   *  Default: the collector's {@link
   *  import('./broadcast-collector.js').DEFAULT_SEAT_CONCURRENCY}. */
  readonly maxSeatConcurrency?: number;
  /** Per-seat dispatch timeout (ms) — a hung seat can't stall the board (#351). Default:
   *  the collector's {@link
   *  import('./broadcast-collector.js').DEFAULT_SEAT_TIMEOUT_MS}. */
  readonly seatTimeoutMs?: number;
}

/** The inputs one council run is configured from. */
export interface CouncilRunInput {
  readonly councilRunId: string;
  /** The resolved preset (its id's registry value). Validated at Frame. */
  readonly preset: CouncilPreset;
  /** The task the council debates. */
  readonly objective: string;
  /** The working directory seat sessions run in. Absent ⇒ the process cwd. */
  readonly cwd?: string;
}

export class Conductor {
  /** Governors of currently-running councils, so {@link kill} can reach a live run. */
  private readonly active = new Map<string, RunGovernor>();

  constructor(private readonly deps: ConductorDeps) {}

  /** Throw the kill switch for a running council (safety #4). Returns false if the run
   *  is unknown (already finished or never started). Idempotent. */
  kill(councilRunId: string): boolean {
    const governor = this.active.get(councilRunId);
    if (governor === undefined) return false;
    governor.kill();
    this.deps.logger?.info('council run killed', { councilRunId });
    return true;
  }

  /** Whether a council run is currently active. */
  isActive(councilRunId: string): boolean {
    return this.active.has(councilRunId);
  }

  /**
   * Run one council to a terminal state. Degrade-not-throw: an unexpected error
   * surfaces as a `failed` result, never a rejected promise. The full transcript is
   * always returned (safety #7).
   */
  async run(input: CouncilRunInput): Promise<CouncilRunResult> {
    const { councilRunId, preset } = input;

    // ── Frame: reject an invalid preset up front; nothing runs. ────────────────
    const validation = validateCouncilPreset(preset);
    if (!validation.valid) {
      this.deps.logger?.warn('council preset rejected at frame', {
        councilRunId,
        issues: validation.issues.map((i) => i.code),
      });
      return {
        councilRunId,
        status: 'invalid-preset',
        transcript: this.deps.bus.seatView(councilRunId, 'conductor').read(),
        usage: { totalTokens: 0, costUsd: 0, rounds: 0 },
        issues: validation.issues,
      };
    }

    const governor = new RunGovernor(preset.budget);
    this.active.set(councilRunId, governor);
    const bus = observeBus(
      this.deps.bus.conductor(councilRunId),
      (entry) => this.deps.onEntry?.(entry),
    );
    const seats: SeatContext[] = preset.seats.map((seat) => ({
      seatId: seat.id,
      role: seat.role,
      model: seat.model,
    }));

    try {
      return await this.drive(input, bus, governor, seats);
    } catch (error) {
      this.deps.logger?.warn('council run crashed', { councilRunId, error });
      return this.result(councilRunId, 'failed', governor);
    } finally {
      this.active.delete(councilRunId);
    }
  }

  /** The Frame → Propose → Debate → Converge sequence for a validated preset. */
  private async drive(
    input: CouncilRunInput,
    bus: ConductorBus,
    governor: RunGovernor,
    seats: SeatContext[],
  ): Promise<CouncilRunResult> {
    const { councilRunId, preset, objective } = input;

    bus.note(
      'frame',
      `Council "${preset.label}" framed. Objective: ${objective}. ` +
        `Success criterion: ${preset.successCriterion}.`,
    );

    // ── Propose (BLIND, parallel): no peer content enters a Propose prompt. ─────
    const proposeOutputs = await this.propose(input, bus, governor, seats);
    const proposeHalt = this.governorStatus(governor);
    if (proposeHalt !== null) {
      return this.result(councilRunId, proposeHalt.status, governor, proposeHalt.haltedBy);
    }

    // ── Debate (≤2 rounds, early-stop on stability). ───────────────────────────
    const debate = await runDebateRounds({
      bus,
      seats,
      governor,
      stageMaxRounds: this.debateMaxRounds(preset),
      priorOutputs: proposeOutputs,
      dispatch: this.dispatchConfig(preset, seats),
      buildPrompt: (seat, round, peerText) =>
        debatePrompt(objective, seat, round, peerText),
      runTurn: (seat, prompt, signal) =>
        this.runTurn(input, seat, 'debate', prompt, signal),
    });
    if (debate.halt !== null) {
      const status: CouncilRunStatus =
        debate.halt.kind === 'killed' ? 'killed' : 'budget-exhausted';
      return this.result(councilRunId, status, governor, debate.halt.cause);
    }

    // ── Converge: HUMAN judge only — park the final positions for a human. ──────
    return this.converge(input, bus, governor, seats, debate.finalOutputs);
  }

  /** Propose stage: drive every seat from the objective ALONE (blind) through the
   *  broadcast collector — bounded concurrency, a per-seat timeout so a hung seat can't
   *  stall the stage, and a pre-dispatch budget reservation so a parallel Propose can't
   *  overshoot the caps (#351, LOW-A). Records each responder's proposal onto the bus
   *  and returns the proposals keyed by seat id (a timed-out seat contributes none). */
  private async propose(
    input: CouncilRunInput,
    bus: ConductorBus,
    governor: RunGovernor,
    seats: SeatContext[],
  ): Promise<Map<string, string>> {
    const { broadcastId } = bus.broadcast(
      'propose',
      'Propose your best answer independently. You cannot see other seats yet.',
    );

    const broadcast = await collectBroadcast<SeatContext>({
      broadcastId,
      seats,
      governor,
      ...this.dispatchConfig(input.preset, seats),
      signal: governor.signal,
      run: (seat, dispatch) =>
        this.runTurn(
          input,
          seat,
          'propose',
          proposePrompt(input.objective, seat),
          dispatch.signal,
        ),
    });

    const outputs = new Map<string, string>();
    for (const outcome of broadcast.responders) {
      const content = outcome.result?.content ?? '';
      bus.postSeatMessage({
        stage: 'propose',
        seatId: outcome.seat.seatId,
        role: outcome.seat.role,
        content,
        broadcastId,
      });
      outputs.set(outcome.seat.seatId, content);
    }
    return outputs;
  }

  /** Converge stage (HUMAN): record each seat's final position and park the decision
   *  for the human judge. No agent-judge, no vote (P1). */
  private converge(
    input: CouncilRunInput,
    bus: ConductorBus,
    governor: RunGovernor,
    seats: SeatContext[],
    finalOutputs: Map<string, string>,
  ): CouncilRunResult {
    const positions: SeatPosition[] = seats.map((seat) => ({
      seatId: seat.seatId,
      role: seat.role,
      content: finalOutputs.get(seat.seatId) ?? '',
    }));

    bus.note(
      'converge',
      `Debate closed after ${governor.totals.rounds} round(s). ` +
        `Parking ${positions.length} final position(s) for the human judge.`,
    );

    const base = this.result(input.councilRunId, 'converged', governor);
    return {
      ...base,
      pendingDecision: {
        councilRunId: input.councilRunId,
        successCriterion: input.preset.successCriterion,
        positions,
      },
    };
  }

  /** Drive one seat turn through the {@link SeatDriver} seam, threading the collector's
   *  per-seat abort `signal` (which fires on kill/budget OR the collector's own timeout /
   *  quorum cutoff) so the driver can bail on any of them. */
  private runTurn(
    input: CouncilRunInput,
    seat: SeatContext,
    stage: DebateStage,
    prompt: string,
    signal: AbortSignal,
  ): Promise<SeatTurnResult> {
    return this.deps.seatDriver.runTurn({
      seat,
      stage,
      prompt,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      signal,
    });
  }

  /** The broadcast-collector knobs shared by Propose + Debate: bounded concurrency, the
   *  per-seat timeout, and the per-turn budget reservation (LOW-A). Both stages dispatch
   *  through the same collector, so their concurrency + overshoot bounds are identical. */
  private dispatchConfig(
    preset: CouncilPreset,
    seats: readonly SeatContext[],
  ): {
    maxConcurrency?: number;
    timeoutMs?: number;
    estimate: TurnEstimate;
  } {
    return {
      ...(this.deps.maxSeatConcurrency !== undefined
        ? { maxConcurrency: this.deps.maxSeatConcurrency }
        : {}),
      ...(this.deps.seatTimeoutMs !== undefined
        ? { timeoutMs: this.deps.seatTimeoutMs }
        : {}),
      estimate: this.turnEstimate(preset, seats),
    };
  }

  /** A conservative per-turn budget estimate the collector RESERVES before dispatch
   *  (#351, LOW-A): each turn's fair share of the run budget over every turn the run may
   *  take (`seats × (1 Propose + Debate maxRounds)`). Under-estimates settle down and
   *  free headroom; over-estimates are caught by the post-stage cap check. This bounds a
   *  parallel broadcast's overshoot to at most one in-flight estimate, never a round. */
  private turnEstimate(
    preset: CouncilPreset,
    seats: readonly SeatContext[],
  ): TurnEstimate {
    const plannedTurns = Math.max(
      1,
      seats.length * (1 + this.debateMaxRounds(preset)),
    );
    return {
      tokens: Math.ceil(preset.budget.maxTotalTokens / plannedTurns),
      costUsd: preset.budget.maxCostUsd / plannedTurns,
    };
  }

  /** The terminal status the governor implies after a stage, or null to continue.
   *  Separates a kill from a specific budget cap. */
  private governorStatus(
    governor: RunGovernor,
  ): { status: CouncilRunStatus; haltedBy?: BudgetHaltCause } | null {
    if (governor.killed) return { status: 'killed' };
    const cause = governor.capBreached();
    if (cause !== null) return { status: 'budget-exhausted', haltedBy: cause };
    return null;
  }

  /** Assemble a terminal {@link CouncilRunResult} from the run's transcript + totals. */
  private result(
    councilRunId: string,
    status: CouncilRunStatus,
    governor: RunGovernor,
    haltedBy?: BudgetHaltCause,
  ): CouncilRunResult {
    return {
      councilRunId,
      status,
      transcript: this.deps.bus.seatView(councilRunId, 'conductor').read(),
      usage: governor.totals,
      ...(haltedBy !== undefined ? { haltedBy } : {}),
    };
  }

  /** The Debate stage's `maxRounds` from the preset (`≤2`); defaults to 1 if the preset
   *  declares no Debate step. */
  private debateMaxRounds(preset: CouncilPreset): number {
    const debate = preset.stages.find((step) => step.stage === 'debate');
    return debate?.maxRounds ?? (debate !== undefined ? 1 : 0);
  }
}
