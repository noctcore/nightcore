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
  });
});
