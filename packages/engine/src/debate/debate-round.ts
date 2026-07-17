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
import { collectBroadcast } from './broadcast-collector.js';
import type { ConductorBus } from './bus.js';
import type { RunGovernor } from './conductor-budget.js';
import type {
  BudgetHaltCause,
  SeatContext,
  SeatTurnResult,
  TurnEstimate,
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

/** The broadcast-collector knobs the debate loop dispatches each round through. */
export interface DebateDispatchConfig {
  /** Max seats dispatched at once (bounded concurrency). */
  readonly maxConcurrency?: number;
  /** Per-seat dispatch timeout (ms) so a hung seat can't stall a round. */
  readonly timeoutMs?: number;
  /** Per-turn budget reserved before dispatch (LOW-A: no cap overshoot). */
  readonly estimate?: TurnEstimate;
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
  /** Bounded-concurrency + timeout + reservation config for the per-round broadcast.
   *  Absent ⇒ the collector's defaults (unbounded-estimate, default concurrency/timeout). */
  readonly dispatch?: DebateDispatchConfig;
  /** The editable routing FILTER (issue #371): the seat ids that may inform `toSeatId`
   *  this round, or `null` for the OPEN default (every peer informs it). Read FRESH each
   *  round so a live routing edit takes effect on the next round. It only NARROWS which
   *  mediated peers a seat hears — it is applied BEFORE {@link assemblePeerContext}, so
   *  every surviving peer still flows through the quoted+scanned delivery path (safety
   *  #1/#2). Absent ⇒ open routing (unit tests that don't exercise routing omit it). */
  informers?(toSeatId: string): ReadonlySet<string> | null;
  /** Build a seat's debate prompt for `round`, embedding the mediated `peerText`
   *  (which contains ONLY quoted+scanned peer content). */
  buildPrompt(seat: SeatContext, round: number, peerText: string): string;
  /** Drive one seat turn through the {@link SeatDriver} seam, threading the collector's
   *  per-seat abort `signal` (kill/budget/timeout/quorum). */
  runTurn(
    seat: SeatContext,
    prompt: string,
    signal: AbortSignal,
  ): Promise<SeatTurnResult>;
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

    // Assemble every seat's mediated prompt FIRST, sequentially, from that fixed
    // snapshot. Each prompt's peer content is the quoted, injection-scanned delivery text
    // — never raw `read()` content (MEDIUM guard). The routing FILTER (issue #371) is
    // applied HERE, before delivery: it only narrows the snapshot to the seat's informers,
    // so every surviving peer still flows through `assemblePeerContext` → the quoted+
    // scanned path. A routing edit can therefore never introduce an un-mediated peer path
    // — it can only subtract peers (safety #1/#2). Doing this before dispatch keeps the
    // delivery transcript order deterministic and out of the concurrent section.
    const prompts = new Map<string, string>();
    for (const seat of seats) {
      const allowed = hooks.informers?.(seat.seatId) ?? null;
      const visible =
        allowed === null
          ? snapshot
          : snapshot.filter((peer) => allowed.has(peer.seatId));
      const peers = assemblePeerContext(bus, 'debate', seat.seatId, visible);
      prompts.set(seat.seatId, hooks.buildPrompt(seat, round, peers.text));
    }

    // Dispatch the round as ONE broadcast: bounded concurrency + per-seat timeout +
    // budget reservation. A hung seat is recorded timed-out and keeps its prior
    // position rather than stalling the round.
    const broadcast = await collectBroadcast<SeatContext>({
      broadcastId: `debate-r${round}`,
      seats,
      governor,
      ...(hooks.dispatch ?? {}),
      signal: governor.signal,
      run: (seat, dispatch) =>
        hooks.runTurn(seat, prompts.get(seat.seatId) ?? '', dispatch.signal),
    });

    const next = new Map(current);
    let changed = false;
    for (const outcome of broadcast.responders) {
      const { seatId, role } = outcome.seat;
      const content = outcome.result?.content ?? '';
      // Carry the round's broadcast id so a round's replies group side-by-side in the
      // reply diff (issue #353) — the same grouping Propose's replies already get.
      bus.postSeatMessage({
        stage: 'debate',
        seatId,
        role,
        content,
        broadcastId: outcome.broadcastId,
      });
      if (content !== (current.get(seatId) ?? '')) changed = true;
      next.set(seatId, content);
    }

    // A kill or a hard cap tripped mid-round: halt WITHOUT counting the round (the
    // partial responders are still folded into `next` for the transcript/converge).
    const roundHalt = governorHalt(governor);
    if (roundHalt !== null) {
      return { finalOutputs: next, halt: roundHalt, stableEarlyStop };
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
