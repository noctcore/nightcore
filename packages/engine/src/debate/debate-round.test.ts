/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { CouncilBudget, TokenUsage } from '@nightcore/contracts';

import { DebateBus } from './bus.js';
import { RunGovernor } from './conductor-budget.js';
import type { SeatContext, SeatTurnResult } from './conductor-types.js';
import { runDebateRounds } from './debate-round.js';
import { quoteForSeat } from './quoted-delivery.js';

const NO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningOutputTokens: 0,
};

const SEATS: SeatContext[] = [
  { seatId: 'a', role: 'proposer', model: 'm1' },
  { seatId: 'b', role: 'critic', model: 'm2' },
];

const OPEN_BUDGET: CouncilBudget = {
  maxRounds: 5,
  maxTotalTokens: 1_000_000_000,
  maxCostUsd: 1_000_000_000,
};

interface PromptCall {
  seatId: string;
  round: number;
  peerText: string;
}

function harness(
  overrides: Partial<Parameters<typeof runDebateRounds>[0]> = {},
) {
  const bus = new DebateBus().conductor('r');
  const prompts: PromptCall[] = [];
  return {
    prompts,
    hooks: {
      bus,
      seats: SEATS,
      governor: new RunGovernor(OPEN_BUDGET),
      stageMaxRounds: 2,
      priorOutputs: new Map([
        ['a', 'A0'],
        ['b', 'B0'],
      ]),
      buildPrompt: (seat: SeatContext, round: number, peerText: string) => {
        prompts.push({ seatId: seat.seatId, round, peerText });
        return `${seat.seatId}#${round}`;
      },
      runTurn: (): Promise<SeatTurnResult> =>
        Promise.resolve({ content: 'STABLE', usage: NO_USAGE, costUsd: 0 }),
      ...overrides,
    },
  };
}

describe('runDebateRounds (the forked convergence loop)', () => {
  test('every seat in a round reacts to the SAME prior-round snapshot, mediated + quoted', async () => {
    // Never-stable outputs so we get 2 full rounds to inspect.
    let n = 0;
    const { hooks, prompts } = harness({
      runTurn: (): Promise<SeatTurnResult> =>
        Promise.resolve({ content: `u${n++}`, usage: NO_USAGE, costUsd: 0 }),
    });

    await runDebateRounds(hooks);

    const round1 = prompts.filter((p) => p.round === 1);
    const aR1 = round1.find((p) => p.seatId === 'a')!;
    const bR1 = round1.find((p) => p.seatId === 'b')!;

    // Seat a hears b's PRIOR output B0 (quoted), and vice-versa — even though a ran
    // first, b still reacts to the prior snapshot A0, not a's fresh round-1 output.
    expect(aR1.peerText).toContain(quoteForSeat('b', 'B0').text);
    expect(bR1.peerText).toContain(quoteForSeat('a', 'A0').text);
    expect(bR1.peerText).not.toContain('u0'); // NOT a's round-1 output
    // Peer text is always the quoted, fenced rendering — never raw content.
    expect(aR1.peerText).toContain('BEGIN UNTRUSTED');
    expect(aR1.peerText).not.toContain('B0"'); // raw B0 never bare
  });

  test('early-stops on stability (a round that changes nothing)', async () => {
    // priorOutputs are A0/B0; runTurn returns STABLE, which differs on round 1 (so
    // round 1 changes), then is identical on round 2 ⇒ stop after round 2.
    const { hooks } = harness();
    const outcome = await runDebateRounds(hooks);
    expect(outcome.stableEarlyStop).toBe(true);
    expect(hooks.governor.totals.rounds).toBe(2);
    expect(outcome.halt).toBeNull();
  });

  test('immediate stability stops after ONE round', async () => {
    // Seats echo their PRIOR outputs ⇒ round 1 changes nothing ⇒ stop at round 1.
    const { hooks } = harness({
      runTurn: (seat: SeatContext): Promise<SeatTurnResult> =>
        Promise.resolve({
          content: seat.seatId === 'a' ? 'A0' : 'B0',
          usage: NO_USAGE,
          costUsd: 0,
        }),
    });
    const outcome = await runDebateRounds(hooks);
    expect(outcome.stableEarlyStop).toBe(true);
    expect(hooks.governor.totals.rounds).toBe(1);
  });

  test('halts at the round cap when positions never stabilize', async () => {
    let n = 0;
    const { hooks } = harness({
      stageMaxRounds: 2,
      runTurn: (): Promise<SeatTurnResult> =>
        Promise.resolve({ content: `x${n++}`, usage: NO_USAGE, costUsd: 0 }),
    });
    const outcome = await runDebateRounds(hooks);
    expect(hooks.governor.totals.rounds).toBe(2);
    expect(outcome.stableEarlyStop).toBe(false);
    expect(outcome.halt).toBeNull();
  });

  test('halts on a token cap breached mid-loop', async () => {
    const governor = new RunGovernor({
      maxRounds: 5,
      maxTotalTokens: 150,
      maxCostUsd: 1_000_000,
    });
    let n = 0;
    const { hooks } = harness({
      governor,
      runTurn: (): Promise<SeatTurnResult> =>
        Promise.resolve({
          content: `x${n++}`,
          usage: { ...NO_USAGE, inputTokens: 100 },
          costUsd: 0,
        }),
    });
    const outcome = await runDebateRounds(hooks);
    expect(outcome.halt).toEqual({ kind: 'budget', cause: 'maxTotalTokens' });
    expect(outcome.noProgressEarlyStop).toBe(false);
  });
});

// ── No-progress (stall) early-stop (issue #372) ────────────────────────────────

/** A driver whose seats KEEP changing every round (so stability never fires) yet only
 *  ever reshuffle two fixed positions — the reply diff sees no NEW distinct position, so
 *  the debate is churning. Seat `a` and seat `b` swap which pooled position they hold each
 *  round. Pair with `priorOutputs` seeded to the same pool so the churn is immediate. */
function churnDriver(
  poolA: string,
  poolB: string,
): (seat: SeatContext) => Promise<SeatTurnResult> {
  const roundBySeat = new Map<string, number>();
  return (seat: SeatContext): Promise<SeatTurnResult> => {
    const round = (roundBySeat.get(seat.seatId) ?? 0) + 1;
    roundBySeat.set(seat.seatId, round);
    const odd = round % 2 === 1;
    const content = seat.seatId === 'a' ? (odd ? poolB : poolA) : odd ? poolA : poolB;
    return Promise.resolve({ content, usage: NO_USAGE, costUsd: 0 });
  };
}

describe('runDebateRounds — no-progress churn early-stop (issue #372)', () => {
  test('churn (positions reshuffled, never stabilizing) stops EARLY and routes to Converge', async () => {
    // Seed the two positions {P, Q}; the churn driver just swaps who holds which each
    // round. Stability never fires (every round changes), but no new distinct position is
    // ever introduced ⇒ the no-progress detector stops at the threshold (2 rounds).
    const { hooks } = harness({
      stageMaxRounds: 5,
      priorOutputs: new Map([
        ['a', 'P'],
        ['b', 'Q'],
      ]),
      runTurn: churnDriver('P', 'Q'),
    });

    const outcome = await runDebateRounds(hooks);

    expect(outcome.noProgressEarlyStop).toBe(true);
    // Distinct from the #350 stability stop — the seats DID keep moving.
    expect(outcome.stableEarlyStop).toBe(false);
    expect(outcome.halt).toBeNull(); // halt-free ⇒ the Conductor routes it to Converge
    // Stopped at the threshold, well before the 5-round cap.
    expect(hooks.governor.totals.rounds).toBe(2);
  });

  test('a no-progress stop records an auditable note on the transcript (the human flag)', async () => {
    const debateBus = new DebateBus();
    const outcome = await runDebateRounds({
      bus: debateBus.conductor('r'),
      seats: SEATS,
      governor: new RunGovernor(OPEN_BUDGET),
      stageMaxRounds: 5,
      priorOutputs: new Map([
        ['a', 'P'],
        ['b', 'Q'],
      ]),
      buildPrompt: (seat: SeatContext, round: number) => `${seat.seatId}#${round}`,
      runTurn: churnDriver('P', 'Q'),
    });

    expect(outcome.noProgressEarlyStop).toBe(true);
    // The stall reason is appended to the run's append-only transcript as a debate-stage
    // conductor note — auditable + replayable (safety #7), streamed over nc:debate by the
    // observer with no new channel.
    const transcript = debateBus.seatView('r', 'conductor').read();
    const stallNote = transcript.find(
      (entry) =>
        entry.stage === 'debate' &&
        entry.kind === 'note' &&
        entry.content.includes('No-progress detected'),
    );
    expect(stallNote).toBeDefined();
  });

  test('genuine progress (a new distinct position every round) runs the FULL cap — no false stall', async () => {
    let n = 0;
    const { hooks } = harness({
      stageMaxRounds: 5,
      runTurn: (): Promise<SeatTurnResult> =>
        // Unique content every turn ⇒ a new distinct position each round ⇒ never a stall.
        Promise.resolve({ content: `new-${n++}`, usage: NO_USAGE, costUsd: 0 }),
    });

    const outcome = await runDebateRounds(hooks);

    expect(outcome.noProgressEarlyStop).toBe(false);
    expect(outcome.stableEarlyStop).toBe(false);
    expect(outcome.halt).toBeNull();
    // Ran to the round cap — the detector never cut a productive debate short.
    expect(hooks.governor.totals.rounds).toBe(5);
  });

  test('STRICT SHORTENER: the detector never lets a run exceed the round cap', async () => {
    const cap = 5;

    // Churn: the detector SHORTENS the run (fewer rounds than the cap)…
    const churn = harness({
      stageMaxRounds: cap,
      priorOutputs: new Map([
        ['a', 'P'],
        ['b', 'Q'],
      ]),
      runTurn: churnDriver('P', 'Q'),
    });
    const churnOutcome = await runDebateRounds(churn.hooks);
    expect(churnOutcome.noProgressEarlyStop).toBe(true);
    expect(churn.hooks.governor.totals.rounds).toBeLessThan(cap);

    // …and even under relentless (never-repeating) progress it stops AT the cap, never
    // past it — the stall detector can only tighten the bound, never loosen it (safety #4).
    let n = 0;
    const progress = harness({
      stageMaxRounds: cap,
      runTurn: (): Promise<SeatTurnResult> =>
        Promise.resolve({ content: `p-${n++}`, usage: NO_USAGE, costUsd: 0 }),
    });
    const progressOutcome = await runDebateRounds(progress.hooks);
    expect(progressOutcome.halt).toBeNull();
    expect(progress.hooks.governor.totals.rounds).toBe(cap);
    expect(progress.hooks.governor.totals.rounds).toBeLessThanOrEqual(cap);
  });
});
