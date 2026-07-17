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
 *   Frame → Propose (blind, parallel) → Debate (≤2 rounds, early-stop) → Converge (gate → HUMAN)
 *
 *  - **Frame**: reject an invalid preset up front (`validateCouncilPreset`), else seed
 *    the run (a frame note + a broadcast of the objective).
 *  - **Propose** (BLIND, parallel): each seat proposes from the objective ALONE — no
 *    peer content enters a Propose prompt, so diversity survives into Debate.
 *  - **Debate** (`≤2` rounds): seats react to peers' prior outputs, but ONLY via the
 *    mediated quoted path; early-stop when positions stabilize (`debate-round.ts`).
 *  - **Converge**: run the OBJECTIVE GATE (issue #365, safety #6) when configured — a
 *    deterministic tests/repro/build check whose RED verdict OVERRIDES consensus (a seat
 *    answer can't be adopted without an explicit human override) — then park the final
 *    positions for the human judge (safety #7). No gate ⇒ human-only, as in P1.
 *
 * Hard budget/round caps + a kill switch are enforced throughout by a per-run
 * {@link RunGovernor} (safety #4). The whole machine + its safety invariants are
 * driven by deterministic fake seats in the tests — no live provider call.
 */
import type {
  CouncilPreset,
  CouncilRoutingEdge,
  DebateStage,
  DebateTranscriptEntry,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { collectBroadcast } from './broadcast-collector.js';
import type { ConductorBus, DebateBus } from './bus.js';
import { RunGovernor } from './conductor-budget.js';
import {
  type ParkedConverge,
  resolveParkedConverge,
  runConverge,
} from './conductor-converge.js';
import {
  debateMaxRounds,
  stageDispatchConfig,
} from './conductor-dispatch.js';
import { observeBus } from './conductor-observer.js';
import { debatePrompt, proposePrompt } from './conductor-prompts.js';
import {
  applyRoutingDirective,
  type RunRoutingRuntime,
  seedRoutingRuntime,
} from './conductor-routing.js';
import type {
  BudgetHaltCause,
  ConvergeDecision,
  ConvergeResolution,
  CouncilRunResult,
  CouncilRunStatus,
  SeatContext,
  SeatDriver,
  SeatTurnResult,
} from './conductor-types.js';
import type { RoutingPolicy, RoutingUpdate } from './council-routing.js';
import { runDebateRounds } from './debate-round.js';
import type { ObjectiveGate } from './objective-gate.js';
import { validateCouncilPreset } from './preset-validator.js';

export interface ConductorDeps {
  /** The debate bus (owns the append-only transcript store). A fresh bus per run
   *  keeps runs isolated; a shared bus is fine (the store is run-keyed). */
  readonly bus: DebateBus;
  /** The provider-neutral seat driver (fake in tests; session-backed in production). */
  readonly seatDriver: SeatDriver;
  readonly logger?: Logger;
  /** Observe every transcript entry as it is appended — the single emit chokepoint the
   *  `nc:debate` stream wires (the canvas slice, #352). Carries the `councilRunId` the
   *  entry belongs to (the entry keys externally in the store), so a downstream sink can
   *  tag the wire event with its run. Default: no-op. */
  readonly onEntry?: (
    councilRunId: string,
    entry: DebateTranscriptEntry,
  ) => void;
  /** Max seats the broadcast collector dispatches at once (bounded concurrency, #351).
   *  Default: the collector's {@link
   *  import('./broadcast-collector.js').DEFAULT_SEAT_CONCURRENCY}. */
  readonly maxSeatConcurrency?: number;
  /** Per-seat dispatch timeout (ms) — a hung seat can't stall the board (#351). Default:
   *  the collector's {@link
   *  import('./broadcast-collector.js').DEFAULT_SEAT_TIMEOUT_MS}. */
  readonly seatTimeoutMs?: number;
  /** The objective gate run at Converge (issue #365, safety #6): a DETERMINISTIC
   *  tests/repro/build check whose RED verdict OVERRIDES debate consensus. Absent ⇒ a
   *  pure-reasoning run — the human decides the parked positions alone (P1 behaviour). */
  readonly objectiveGate?: ObjectiveGate;
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

  /** Live routing handles per running council, so {@link setRouting} can rewire the
   *  Debate graph of a run in flight (issue #371). Set + cleared alongside {@link active}. */
  private readonly runtimes = new Map<string, RunRoutingRuntime>();

  /** Runs parked at Converge, awaiting the human judge's verdict ({@link
   *  resolveConverge}) — the P1 terminal authority is the human (safety #7). */
  private readonly parked = new Map<string, ParkedConverge>();

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

  /** Rewire a LIVE run's routing graph — the editable canvas edges (issue #371). A
   *  CONDUCTOR DIRECTIVE, never a direct seat write: it only changes WHICH already-
   *  mediated, quoted, injection-scanned peers reach a seat next Debate round (safety
   *  #1/#2). Delegates to {@link applyRoutingDirective}, which replaces the edge set and
   *  records the change onto the append-only transcript. Refused for an unknown/finished
   *  run. */
  setRouting(
    councilRunId: string,
    edges: readonly CouncilRoutingEdge[],
  ): RoutingUpdate {
    return applyRoutingDirective(
      this.runtimes.get(councilRunId),
      councilRunId,
      edges,
      this.deps.logger,
    );
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
      (entry) => this.deps.onEntry?.(councilRunId, entry),
    );
    const seats: SeatContext[] = preset.seats.map((seat) => ({
      seatId: seat.id,
      role: seat.role,
      model: seat.model,
    }));
    // The run's live routing handle, seeded from the preset (issue #371). The human
    // rewires it live through {@link setRouting}; the Debate loop reads it fresh each round.
    const runtime = seedRoutingRuntime(bus, preset.routing, seats);
    this.runtimes.set(councilRunId, runtime);

    try {
      return await this.drive(input, bus, governor, seats, runtime.routing);
    } catch (error) {
      this.deps.logger?.warn('council run crashed', { councilRunId, error });
      return this.result(councilRunId, 'failed', governor);
    } finally {
      this.active.delete(councilRunId);
      this.runtimes.delete(councilRunId);
    }
  }

  /** The Frame → Propose → Debate → Converge sequence for a validated preset. */
  private async drive(
    input: CouncilRunInput,
    bus: ConductorBus,
    governor: RunGovernor,
    seats: SeatContext[],
    routing: RoutingPolicy,
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
      stageMaxRounds: debateMaxRounds(preset),
      priorOutputs: proposeOutputs,
      dispatch: stageDispatchConfig(preset, seats, this.deps),
      // The editable routing filter (issue #371), read FRESH each round so a live rewire
      // applies on the next round. It only narrows which mediated peers a seat hears.
      informers: (toSeatId) => routing.informers(toSeatId),
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

    // ── Converge: run the OBJECTIVE GATE (safety #6; a red verdict overrides
    // consensus), then park the positions for the human judge. ──────────────────
    const pending = await runConverge({
      parked: this.parked,
      bus,
      gate: this.deps.objectiveGate,
      run: input,
      seats,
      finalOutputs: debate.finalOutputs,
      rounds: governor.totals.rounds,
      signal: governor.signal,
      logger: this.deps.logger,
    });
    return { ...this.result(councilRunId, 'converged', governor), pendingDecision: pending };
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
      ...stageDispatchConfig(input.preset, seats, this.deps),
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

  /** Whether a run is parked at Converge, awaiting the human judge's verdict. */
  isAwaitingConverge(councilRunId: string): boolean {
    return this.parked.has(councilRunId);
  }

  /** Resolve a run's PARKED Converge decision with the human judge's verdict (issue
   *  #353, safety #7 — the human is the terminal authority). Delegates to {@link
   *  resolveParkedConverge}, which records the verdict onto the append-only transcript
   *  through the run's mediated bus (never a direct store write — safety #1) and closes
   *  the run. A refused verdict records nothing and leaves the run parked. */
  resolveConverge(
    councilRunId: string,
    decision: ConvergeDecision,
  ): ConvergeResolution {
    return resolveParkedConverge(
      this.parked,
      councilRunId,
      decision,
      () => this.deps.bus.seatView(councilRunId, 'conductor').read(),
      this.deps.logger,
    );
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

}
