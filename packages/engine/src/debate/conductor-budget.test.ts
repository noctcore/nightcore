/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { CouncilBudget, TokenUsage } from '@nightcore/contracts';

import { RunGovernor } from './conductor-budget.js';
import type { SeatTurnResult } from './conductor-types.js';

const BUDGET: CouncilBudget = {
  maxRounds: 2,
  maxTotalTokens: 300,
  maxCostUsd: 10,
};

function turn(inputTokens: number, costUsd = 0): SeatTurnResult {
  const usage: TokenUsage = {
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningOutputTokens: 0,
  };
  return { content: 'x', usage, costUsd };
}

describe('RunGovernor — token/cost caps', () => {
  test('within budget, capBreached() is null', () => {
    const g = new RunGovernor(BUDGET);
    g.chargeTurn(turn(100, 1));
    expect(g.capBreached()).toBeNull();
    expect(g.totals).toEqual({ totalTokens: 100, costUsd: 1, rounds: 0 });
  });

  test('the total-token cap trips at the ceiling', () => {
    const g = new RunGovernor(BUDGET);
    g.chargeTurn(turn(150));
    g.chargeTurn(turn(150)); // 300 >= 300
    expect(g.capBreached()).toBe('maxTotalTokens');
  });

  test('the cost cap trips at the ceiling', () => {
    const g = new RunGovernor(BUDGET);
    g.chargeTurn(turn(1, 6));
    g.chargeTurn(turn(1, 4)); // 10 >= 10
    expect(g.capBreached()).toBe('maxCostUsd');
  });

  test('every token field counts toward the total', () => {
    const g = new RunGovernor(BUDGET);
    g.chargeTurn({
      content: 'x',
      usage: {
        inputTokens: 60,
        outputTokens: 60,
        cacheReadTokens: 60,
        cacheCreationTokens: 60,
        reasoningOutputTokens: 60,
      },
      costUsd: 0,
    });
    expect(g.totals.totalTokens).toBe(300);
    expect(g.capBreached()).toBe('maxTotalTokens');
  });
});

describe('RunGovernor — round cap', () => {
  test('roundBudgetRemaining is the MIN of the stage cap and the budget cap', () => {
    const g = new RunGovernor({ ...BUDGET, maxRounds: 5 });
    expect(g.roundBudgetRemaining(2)).toBe(2); // stage cap wins
    const g2 = new RunGovernor({ ...BUDGET, maxRounds: 1 });
    expect(g2.roundBudgetRemaining(2)).toBe(1); // budget cap wins
  });

  test('remaining rounds shrink as rounds are counted, never below zero', () => {
    const g = new RunGovernor(BUDGET);
    expect(g.roundBudgetRemaining(2)).toBe(2);
    g.countRound();
    expect(g.roundBudgetRemaining(2)).toBe(1);
    g.countRound();
    g.countRound();
    expect(g.roundBudgetRemaining(2)).toBe(0);
    expect(g.totals.rounds).toBe(3);
  });
});

describe('RunGovernor — kill switch', () => {
  test('kill latches the flag and aborts the signal; it is idempotent', () => {
    const g = new RunGovernor(BUDGET);
    expect(g.killed).toBe(false);
    expect(g.signal.aborted).toBe(false);

    let aborts = 0;
    g.signal.addEventListener('abort', () => (aborts += 1));

    g.kill();
    g.kill(); // idempotent
    expect(g.killed).toBe(true);
    expect(g.signal.aborted).toBe(true);
    expect(aborts).toBe(1);
  });
});
