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
 *   Frame → Propose (blind, parallel) → Debate (≤2 rounds, early-stop) → [Build (SINGLE
 *   writer, isolated worktree)] → [Review (adversarial)] → Converge (gate → HUMAN)
 *
 *  - **Frame**: reject an invalid preset up front (`validateCouncilPreset`), else seed
 *    the run (a frame note + a broadcast of the objective).
 *  - **Propose** (BLIND, parallel): each seat proposes from the objective ALONE — no
 *    peer content enters a Propose prompt, so diversity survives into Debate
 *    (`conductor-propose.ts`).
 *  - **Debate** (`≤2` rounds): seats react to peers' prior outputs, but ONLY via the
 *    mediated quoted path; early-stop when positions stabilize (`debate-round.ts`).
 *  - **Build** (issue #366, P2, safety #5 — DORMANT unless a preset opts in): after the
 *    debate converges, ONE elected writer executes the plan on an ISOLATED worktree,
 *    write-capable-but-sandboxed; every other seat stays read-only (`conductor-build.ts`).
 *    Runs ONLY when the preset declares a `build` stage AND a `buildDriver` is injected.
 *  - **Review** (issue #369, P2, safety #2/#6/#7 — DORMANT unless a preset opts in): a
 *    SEPARATE reviewer adversarially critiques the writer's Build diff (reusing the PR
 *    phase-4 diff reviewer) before acceptance (`conductor-review.ts`). Runs ONLY when the
 *    preset declares a `review` stage AND a `reviewDriver` is injected AND a Build ran. Its
 *    verdict is ADVISORY scanned data — the objective gate outranks it, the human is terminal.
 *  - **Converge**: run the OBJECTIVE GATE (issue #365, safety #6) when configured — a
 *    deterministic tests/repro/build check whose RED verdict OVERRIDES consensus (a seat
 *    answer can't be adopted without an explicit human override); when a Build ran, the
 *    gate judges the BUILD OUTPUT (the worktree). Then park the final positions for the
 *    human judge (safety #7). No gate ⇒ human-only, as in P1.
 *
 * Hard budget/round caps + a kill switch are enforced throughout by a per-run
 * {@link RunGovernor} (safety #4). The whole machine + its safety invariants are
 * driven by deterministic fake seats in the tests — no live provider call.
 */
import type {
  CouncilPreset,
  CouncilRoutingEdge,
  DebateTranscriptEntry,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type { BuildDriver } from './build-writer.js';
import type { DebateBus } from './bus.js';
import { RunGovernor } from './conductor-budget.js';
import {
  type ParkedConverge,
  resolveParkedConverge,
} from './conductor-converge.js';
import { buildResult, driveCouncil } from './conductor-drive.js';
import { observeBus } from './conductor-observer.js';
import type { ReviewDriver } from './conductor-review.js';
import {
  applyRoutingDirective,
  type RunRoutingRuntime,
  seedRoutingRuntime,
} from './conductor-routing.js';
import type {
  ConvergeDecision,
  ConvergeResolution,
  CouncilRunResult,
  SeatContext,
  SeatDriver,
} from './conductor-types.js';
import type { RoutingUpdate } from './council-routing.js';
import type { GauntletRunner, ObjectiveGate } from './objective-gate.js';
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
   *  pure-reasoning run — the human decides the parked positions alone (P1 behaviour). A
   *  gate resolved per-preset from {@link gauntletRunner} takes precedence over this fixed
   *  gate (see `conductor-drive.ts`), so a mixed CouncilManager can serve both an objective
   *  preset (gets its gate) and `research` (stays gate-less). */
  readonly objectiveGate?: ObjectiveGate;
  /** The INJECTED gauntlet runner (issue #367, safety #6) an OBJECTIVE preset's gate reuses
   *  — the harness `runChecks` bound to the run's worktree in production, a fake in tests.
   *  When present AND the run's preset declares an `objectiveGate` (e.g. the UI-bug preset's
   *  `repro` gate), `driveCouncil` builds the concrete gate from the preset marker via
   *  `objectiveGateForPreset` — no new exec sink (the gauntlet owns the exec). Absent ⇒ no
   *  data-driven gate; the run falls back to {@link objectiveGate} (a pure-reasoning run for
   *  a preset with no marker). DORMANT in production until the write-capable driver + its
   *  worktree land (a tracked follow-up — see `objective-preset.ts`). */
  readonly gauntletRunner?: GauntletRunner;
  /** Consecutive no-progress Debate rounds that trip the #372 stall early-stop (churn
   *  without a new distinct position → route to Converge). A STRICT SHORTENER — only ends a
   *  run sooner, never extends it (safety #4). Default: `DEFAULT_NO_PROGRESS_ROUNDS`. */
  readonly noProgressRounds?: number;
  /** The SINGLE-writer Build driver (issue #366, safety #5). Injected ONLY by a
   *  Build-capable preset (#367/#368) alongside a `build` stage; ABSENT in production
   *  today, so the Build stage is dormant (a council debates plans, it never writes). The
   *  writer runs write-capable-but-sandboxed on an ISOLATED worktree; the objective gate
   *  then judges the build output and can reject it. See `conductor-build.ts`. */
  readonly buildDriver?: BuildDriver;
  /** The adversarial Review driver (issue #369, safety #2/#6/#7). Injected ONLY by a
   *  Build+Review preset alongside a `review` stage; ABSENT in production today, so the
   *  Review stage is dormant. It REUSES the PR phase-4 diff reviewer (read-only per-lens
   *  passes + merge verdict) to independently critique the writer's Build diff before
   *  acceptance. Its verdict is ADVISORY scanned data — the objective gate outranks it and
   *  the human is terminal; it never gates acceptance. See `conductor-review.ts`. */
  readonly reviewDriver?: ReviewDriver;
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
      return await driveCouncil(
        this.deps,
        input,
        bus,
        governor,
        seats,
        runtime.routing,
        this.parked,
      );
    } catch (error) {
      this.deps.logger?.warn('council run crashed', { councilRunId, error });
      return buildResult(this.deps, councilRunId, 'failed', governor);
    } finally {
      this.active.delete(councilRunId);
      this.runtimes.delete(councilRunId);
    }
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
}
