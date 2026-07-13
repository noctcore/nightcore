/**
 * The Council DEBATE round loop (issue #350) — forked and adapted from the Deep-Scan
 * convergence loop (`scans/shared/round-loop.ts`).
 *
 * Deep-Scan's `runRoundLoop` runs a single item's session repeatedly, accumulating
 * net-new findings until a fingerprint-based convergence (K empty rounds) or a round
 * cap. Debate keeps that skeleton — bounded rounds, an early-stop on stability, a hard
 * cap backstop — but changes what a "round" is and what "stable" means:
 *
 *  - A round drives EVERY seat once (not one item's session repeatedly). Within a
 *    round all seats react to the SAME snapshot of the PRIOR round's outputs, so the
 *    round is fair and deterministic (no intra-round ordering bias).
 *  - A seat sees its peers ONLY through the mediated {@link assemblePeerContext}
 *    chokepoint → {@link ConductorBus.deliverBetweenSeats} (quoted + injection-scanned).
 *    Raw peer output NEVER reaches a prompt (carry-forward guard MEDIUM).
 *  - "Stable" = a round in which NO seat changed its position vs the prior round. The
 *    loop early-stops then — debate that stopped moving adds only cost.
 *  - Termination is guaranteed three ways: the preset's Debate `maxRounds` (`≤2`), the
 *    {@link RunGovernor}'s absolute round cap, and its token/cost caps — checked before
 *    every turn so a run halts AT a cap, never past it (safety #4).
 *
 * The loop drives seats through the provider-neutral {@link SeatDriver} seam (via the
 * injected `runTurn`), so it is unit-tested with deterministic fake seats.
 */
import type { ConductorBus } from './bus.js';
import type { RunGovernor } from './conductor-budget.js';
import type {
  BudgetHaltCause,
  SeatContext,
  SeatTurnResult,
} from './conductor-types.js';
import { assemblePeerContext, type PeerOutput } from './peer-context.js';

/** Why a debate loop stopped short of its round cap. */
export interface DebateHalt {
  /** The kill switch, or a hard token/cost cap. */
  readonly kind: 'killed' | 'budget';
  /** The tripped cap, when `kind === 'budget'`. */
  readonly cause?: BudgetHaltCause;
}

/** The result of running the Debate stage. */
export interface DebateOutcome {
  /** Each seat's final output entering Converge, keyed by seat id. Seeded from the
   *  Propose outputs, then overwritten each round. */
  readonly finalOutputs: Map<string, string>;
  /** Non-null when the run was killed or hit a budget cap mid-Debate. */
  readonly halt: DebateHalt | null;
  /** True when the loop early-stopped because positions stabilized (vs the round cap). */
  readonly stableEarlyStop: boolean;
}

/** The seams the debate loop drives. `bus` is the OBSERVING conductor bus (writes are
 *  recorded + streamed by the Conductor); `runTurn` wraps the {@link SeatDriver}. */
export interface DebateRoundHooks {
  readonly bus: ConductorBus;
  readonly seats: readonly SeatContext[];
  readonly governor: RunGovernor;
  /** The Debate stage's own `maxRounds` (`≤2` in P1). */
  readonly stageMaxRounds: number;
  /** The seats' latest outputs entering Debate (from Propose), keyed by seat id. */
  readonly priorOutputs: ReadonlyMap<string, string>;
  /** Build a seat's debate prompt for `round`, embedding the mediated `peerText`
   *  (which contains ONLY quoted+scanned peer content). */
  buildPrompt(seat: SeatContext, round: number, peerText: string): string;
  /** Drive one seat turn through the {@link SeatDriver} seam. */
  runTurn(seat: SeatContext, prompt: string): Promise<SeatTurnResult>;
}

/** The first hard stop the governor reports right now, if any. */
function governorHalt(governor: RunGovernor): DebateHalt | null {
  if (governor.killed) return { kind: 'killed' };
  const cause = governor.capBreached();
  return cause === null ? null : { kind: 'budget', cause };
}

/**
 * Run the Debate stage: at most `min(stageMaxRounds, budget.maxRounds)` rounds,
 * early-stopping when a full round changes no seat's position. Kill + token/cost caps
 * are checked before every turn (safety #4). Returns each seat's final output plus how
 * the loop terminated.
 */
export async function runDebateRounds(
  hooks: DebateRoundHooks,
): Promise<DebateOutcome> {
  const { bus, seats, governor, stageMaxRounds } = hooks;
  const roundBudget = governor.roundBudgetRemaining(stageMaxRounds);
  let current = new Map(hooks.priorOutputs);
  let stableEarlyStop = false;

  for (let round = 1; round <= roundBudget; round++) {
    const preRoundHalt = governorHalt(governor);
    if (preRoundHalt !== null) {
      return { finalOutputs: current, halt: preRoundHalt, stableEarlyStop };
    }

    // Every seat this round reacts to the SAME snapshot of last round's outputs.
    const snapshot: PeerOutput[] = seats.map((seat) => ({
      seatId: seat.seatId,
      role: seat.role,
      content: current.get(seat.seatId) ?? '',
    }));

    const next = new Map(current);
    let changed = false;

    for (const seat of seats) {
      const turnHalt = governorHalt(governor);
      if (turnHalt !== null) {
        return { finalOutputs: next, halt: turnHalt, stableEarlyStop };
      }

      // MEDIUM guard: the ONLY source of peer content in the prompt is the mediated,
      // quoted, injection-scanned delivery text — never raw `read()` content.
      const peers = assemblePeerContext(bus, 'debate', seat.seatId, snapshot);
      const prompt = hooks.buildPrompt(seat, round, peers.text);
      const result = await hooks.runTurn(seat, prompt);

      governor.chargeTurn(result);
      bus.postSeatMessage({
        stage: 'debate',
        seatId: seat.seatId,
        role: seat.role,
        content: result.content,
      });

      if (result.content !== (current.get(seat.seatId) ?? '')) changed = true;
      next.set(seat.seatId, result.content);
    }

    governor.countRound();
    current = next;

    if (!changed) {
      stableEarlyStop = true;
      break;
    }
  }

  return { finalOutputs: current, halt: null, stableEarlyStop };
}
