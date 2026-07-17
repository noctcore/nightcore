/**
 * The Council NON-HUMAN convergence orchestration (issue #370, P2) — the `judge-agent`
 * and `vote` Converge modes, split out of the Conductor so the state machine stays lean.
 *
 * P1 Converge is HUMAN-only ({@link import('./conductor-converge.js').runConverge} parks
 * the seats' positions for the human gavel). P2 adds two AUTONOMOUS modes a preset may
 * select via `convergence`:
 *
 *  - **judge-agent** — a DEDICATED judge seat (asymmetric `judge` role, excluded from the
 *    debate) rules on the debaters' final positions and names the one to adopt.
 *  - **vote** — the debating seats vote on the positions; a quorum (strict majority of
 *    voters) resolves the winner.
 *
 * Three invariants make this SAFE governed autonomy, not "more agents = smarter":
 *
 *  1. The judge/vote output is an UNTRUSTED seat output. It is relayed through the same
 *     mediated, injection-scanned, quoted delivery path every inter-seat message uses
 *     ({@link ConductorBus.deliverBetweenSeats} → `quoteForSeat` → `scanForInjection`), so
 *     it is recorded as a scanned `delivery` and can NEVER be read as an instruction
 *     (safety #1/#2). The Conductor derives the decision by matching the verdict against
 *     the KNOWN parked seat ids (a trusted, system-minted whitelist) — a crafted ruling
 *     can only ever select an existing position or nothing.
 *  2. The OBJECTIVE GATE OUTRANKS every mode (safety #6). A non-human mode auto-closes the
 *     run ONLY when it cleanly adopts a position over a GREEN/absent gate; over a RED gate
 *     it records that the gate overrides it and PARKS for the human — only the human may
 *     deliberately override the gate (safety #7).
 *  3. The outcome lands on the append-only transcript through the Conductor bus (`note` /
 *     `deliverBetweenSeats`), never a direct store write, and an auto-adopt is a
 *     CONDUCTOR note — never a `human`-role verdict, so an agent outcome is never forged
 *     as the human gavel.
 */
import type { Logger } from '@nightcore/shared';

import { collectBroadcast } from './broadcast-collector.js';
import type { ConductorBus } from './bus.js';
import type { RunGovernor } from './conductor-budget.js';
import type { ParkedConverge } from './conductor-converge.js';
import { judgePrompt, votePrompt } from './conductor-prompts.js';
import type {
  PendingConvergeDecision,
  SeatContext,
  SeatTurnResult,
  TurnEstimate,
} from './conductor-types.js';
import { assemblePeerContext, type PeerOutput } from './peer-context.js';

/** The convergence modes this module orchestrates (the non-`human` ones). */
export type AutonomousConvergence = 'judge-agent' | 'vote';

/** A verdict parsed from ONE judge ruling / voter output. `adopt` names a parked seat
 *  (matched against the trusted whitelist); `reject` adopts none; `undecided` is an
 *  unparseable or ambiguous output — the Conductor treats it as "defer to the human". */
export type AutonomousVerdict =
  | { readonly kind: 'adopt'; readonly seatId: string }
  | { readonly kind: 'reject' }
  | { readonly kind: 'undecided' };

/** The collaborators the autonomous convergence drives. `runTurn` wraps the Conductor's
 *  {@link import('./conductor-types.js').SeatDriver} seam bound to the `converge` stage;
 *  `parked` is closed on a clean auto-adopt. */
export interface AutonomousConvergeInput {
  readonly convergence: AutonomousConvergence;
  readonly parked: Map<string, ParkedConverge>;
  readonly bus: ConductorBus;
  /** The parked decision (positions + gate verdict + success criterion + run id). */
  readonly pending: PendingConvergeDecision;
  readonly objective: string;
  /** The dedicated judge seat (`judge-agent` only); the validator guarantees exactly one. */
  readonly judgeSeat: SeatContext | undefined;
  /** The debating seats that vote (`vote` only). */
  readonly voterSeats: readonly SeatContext[];
  readonly governor: RunGovernor;
  /** Bounded-concurrency + timeout + per-turn reservation for the vote broadcast. */
  readonly dispatch: {
    readonly maxConcurrency?: number;
    readonly timeoutMs?: number;
    readonly estimate: TurnEstimate;
  };
  /** Drive one Converge seat turn through the SeatDriver seam (kill/budget signal threaded). */
  readonly runTurn: (
    seat: SeatContext,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<SeatTurnResult>;
  /** The run's abort signal — a kill/budget halt cancels an in-flight judge/vote turn. */
  readonly signal: AbortSignal;
  readonly logger?: Logger;
}

/** Run the selected non-human convergence to completion: gather the judge ruling / votes,
 *  record them as scanned untrusted deliveries, then apply the gate-checked decision. */
export async function runAutonomousConverge(
  input: AutonomousConvergeInput,
): Promise<void> {
  if (input.convergence === 'judge-agent') {
    await runJudgeConverge(input);
  } else {
    await runVoteConverge(input);
  }
}

/** The parked positions as mediatable peer outputs (for `assemblePeerContext`). */
function positionsAsPeers(pending: PendingConvergeDecision): PeerOutput[] {
  return pending.positions.map((position) => ({
    seatId: position.seatId,
    role: position.role,
    content: position.content,
  }));
}

/** judge-agent: run the dedicated judge over the mediated positions and apply its ruling. */
async function runJudgeConverge(input: AutonomousConvergeInput): Promise<void> {
  const { bus, pending, judgeSeat, governor, logger } = input;
  if (judgeSeat === undefined) {
    // Defensive: the validator guarantees a judge seat for judge-agent. Degrade to the
    // human rather than crash if a hand-built preset slipped through.
    bus.note(
      'converge',
      'judge-agent convergence has no judge seat; parking for the human judge.',
    );
    logger?.warn('council judge-agent convergence has no judge seat', {
      councilRunId: pending.councilRunId,
    });
    return;
  }

  // The judge did not debate: it sees ALL debaters' positions (its own id is not among
  // them, so `assemblePeerContext` excludes nothing) delivered QUOTED + scanned.
  const peers = assemblePeerContext(
    bus,
    'converge',
    judgeSeat.seatId,
    positionsAsPeers(pending),
  );
  const prompt = judgePrompt(
    input.objective,
    pending.successCriterion,
    judgeSeat,
    peers.text,
  );
  const result = await input.runTurn(judgeSeat, prompt, input.signal);
  governor.chargeTurn(result);

  // The ruling is UNTRUSTED seat output: relay it through the mediated, injection-scanned,
  // quoted delivery path so the transcript records a scanned `delivery` entry (safety
  // #1/#2) — it is data to weigh, never an instruction to follow.
  bus.deliverBetweenSeats({
    stage: 'converge',
    fromSeatId: judgeSeat.seatId,
    role: judgeSeat.role,
    content: result.content,
  });

  const seatIds = new Set(pending.positions.map((position) => position.seatId));
  const verdict = parseConvergeVerdict(result.content, seatIds);
  applyAutonomousVerdict(input, verdict, judgeRationale(verdict));
}

/** vote: broadcast a vote to the debating seats, tally, and apply the quorum outcome. */
async function runVoteConverge(input: AutonomousConvergeInput): Promise<void> {
  const { bus, pending, voterSeats, governor } = input;
  const positions = positionsAsPeers(pending);
  const { broadcastId } = bus.broadcast(
    'converge',
    'Vote for the strongest position. A quorum (strict majority) resolves the winner.',
  );

  // Assemble every voter's mediated prompt FIRST, sequentially, so the peer-context
  // delivery transcript is deterministic and out of the concurrent dispatch section
  // (mirrors the debate round). Each voter sees its PEERS' positions (its own excluded)
  // delivered QUOTED + injection-scanned — raw peer text never enters a vote prompt.
  const prompts = new Map<string, string>();
  for (const seat of voterSeats) {
    const peers = assemblePeerContext(bus, 'converge', seat.seatId, positions);
    prompts.set(
      seat.seatId,
      votePrompt(input.objective, pending.successCriterion, seat, peers.text),
    );
  }

  const broadcast = await collectBroadcast<SeatContext>({
    broadcastId,
    seats: voterSeats,
    governor,
    ...(input.dispatch.maxConcurrency !== undefined
      ? { maxConcurrency: input.dispatch.maxConcurrency }
      : {}),
    ...(input.dispatch.timeoutMs !== undefined
      ? { timeoutMs: input.dispatch.timeoutMs }
      : {}),
    estimate: input.dispatch.estimate,
    signal: input.signal,
    run: (seat, dispatch) =>
      input.runTurn(seat, prompts.get(seat.seatId) ?? '', dispatch.signal),
  });

  const seatIds = new Set(pending.positions.map((position) => position.seatId));
  const tally = new Map<string, number>();
  for (const outcome of broadcast.responders) {
    const vote = outcome.result?.content ?? '';
    // Every vote is untrusted seat output — record it scanned + quoted (safety #1/#2).
    bus.deliverBetweenSeats({
      stage: 'converge',
      fromSeatId: outcome.seat.seatId,
      role: outcome.seat.role,
      content: vote,
      broadcastId,
    });
    const verdict = parseConvergeVerdict(vote, seatIds);
    if (verdict.kind === 'adopt') {
      tally.set(verdict.seatId, (tally.get(verdict.seatId) ?? 0) + 1);
    }
  }

  // Quorum = strict majority of ALL voters (not just responders): a timed-out voter
  // raises the bar, so an autonomous adoption always has real majority support.
  const quorum = Math.floor(voterSeats.length / 2) + 1;
  const winner = highestVote(tally);
  const verdict: AutonomousVerdict =
    winner !== undefined && winner.votes >= quorum
      ? { kind: 'adopt', seatId: winner.seatId }
      : { kind: 'undecided' };
  applyAutonomousVerdict(
    input,
    verdict,
    voteRationale(tally, quorum, voterSeats.length, winner),
  );
}

/**
 * Apply a non-human verdict (safety #6/#7). A clean `adopt` over a GREEN/absent gate
 * AUTO-CLOSES the run (a conductor note, never a human verdict). Over a RED gate the
 * adoption is REFUSED — the gate outranks the mode and the run parks for the human, who
 * alone may override the gate. A `reject`/`undecided` records the finding and parks.
 */
function applyAutonomousVerdict(
  input: AutonomousConvergeInput,
  verdict: AutonomousVerdict,
  rationale: string,
): void {
  const { bus, pending, parked, convergence, logger } = input;
  const gateRed =
    pending.gateVerdict !== undefined && !pending.gateVerdict.passed;

  if (verdict.kind === 'adopt') {
    if (gateRed) {
      bus.note(
        'converge',
        `${convergence} favored seat "${verdict.seatId}" (${rationale}), but the ` +
          `objective gate is RED (${pending.gateVerdict!.summary}) and OVERRIDES it: a ` +
          `seat position cannot be adopted unless the HUMAN explicitly overrides the gate ` +
          `(safety #6 — objective gates outrank convergence). Parked for the human judge.`,
      );
      logger?.info('council autonomous convergence overridden by red objective gate', {
        councilRunId: pending.councilRunId,
        convergence,
      });
      return;
    }
    bus.note(
      'converge',
      `Council converged by ${convergence}: adopted seat "${verdict.seatId}" (${rationale}).`,
    );
    parked.delete(pending.councilRunId);
    logger?.info('council converged autonomously', {
      councilRunId: pending.councilRunId,
      convergence,
      adopted: verdict.seatId,
    });
    return;
  }

  bus.note(
    'converge',
    `${convergence} reached no adoptable outcome (${rationale}). Parking for the human judge.`,
  );
  logger?.info('council autonomous convergence deferred to the human judge', {
    councilRunId: pending.councilRunId,
    convergence,
    verdict: verdict.kind,
  });
}

/**
 * Parse one judge ruling / voter output into an {@link AutonomousVerdict}. The seat is
 * asked to end with `VERDICT: adopt <seatId>` / `VERDICT: <seatId>` / `VERDICT: reject`;
 * the LAST `VERDICT:` line wins (the seat may reason first). A named seat is matched
 * against `seatIds` — the trusted, system-minted parked whitelist — so an injected id can
 * NEVER select a non-existent position or smuggle an instruction. Ambiguous output (no
 * id, or two+) is `undecided` → deferred to the human. Pure; exported for direct testing.
 */
export function parseConvergeVerdict(
  text: string,
  seatIds: ReadonlySet<string>,
): AutonomousVerdict {
  let verdictLine: string | undefined;
  for (const line of text.split('\n')) {
    const index = line.toUpperCase().indexOf('VERDICT:');
    if (index !== -1) verdictLine = line.slice(index + 'VERDICT:'.length);
  }
  if (verdictLine === undefined) return { kind: 'undecided' };

  const rest = verdictLine.trim();
  const matched = [...seatIds].filter((id) => containsToken(rest, id));
  if (matched.length === 1) return { kind: 'adopt', seatId: matched[0]! };
  if (/\breject\b/i.test(rest) && matched.length === 0) return { kind: 'reject' };
  return { kind: 'undecided' };
}

/** Whether `token` appears in `haystack` as a WHOLE token (bounded by non-word/non-hyphen
 *  or the string ends), so a seat id is never matched as a substring of a longer id. */
function containsToken(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(?:^|[^\\w-])${escaped}(?:[^\\w-]|$)`).test(haystack);
}

/** The single highest-voted seat, or `undefined` on a tie / empty tally (no clear winner). */
function highestVote(
  tally: ReadonlyMap<string, number>,
): { seatId: string; votes: number } | undefined {
  let best: { seatId: string; votes: number } | undefined;
  let tied = false;
  for (const [seatId, votes] of tally) {
    if (best === undefined || votes > best.votes) {
      best = { seatId, votes };
      tied = false;
    } else if (votes === best.votes) {
      tied = true;
    }
  }
  return best !== undefined && !tied ? best : undefined;
}

/** A short audit rationale for a judge verdict. */
function judgeRationale(verdict: AutonomousVerdict): string {
  switch (verdict.kind) {
    case 'adopt':
      return 'the judge ruled to adopt it';
    case 'reject':
      return 'the judge rejected every position';
    case 'undecided':
      return 'the judge named no parked seat';
  }
}

/** A short audit rationale for a vote outcome (the tally + quorum bar). */
function voteRationale(
  tally: ReadonlyMap<string, number>,
  quorum: number,
  voters: number,
  winner: { seatId: string; votes: number } | undefined,
): string {
  const breakdown =
    [...tally.entries()].map(([seatId, votes]) => `${seatId}:${votes}`).join(', ') ||
    'no votes';
  return winner !== undefined
    ? `${winner.seatId} led with ${winner.votes}/${voters}, quorum ${quorum} — [${breakdown}]`
    : `no seat reached quorum ${quorum}/${voters} — [${breakdown}]`;
}
