/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import type { CouncilPreset } from '@nightcore/contracts';

import { validateCouncilPreset } from './preset-validator.js';

/** A minimal, VALID P1 preset the negative cases mutate one invariant at a time. */
const basePreset: CouncilPreset = {
  id: 'research',
  label: 'Research council',
  seats: [
    { id: 'a', role: 'proposer', model: 'claude-opus-4-8' },
    { id: 'b', role: 'critic', model: 'claude-sonnet-4-6' },
  ],
  stages: [
    { stage: 'frame', blind: false },
    { stage: 'propose', blind: true },
    { stage: 'debate', blind: false, maxRounds: 2 },
    { stage: 'converge', blind: false },
  ],
  routing: { mode: 'moderated-bus', edges: [] },
  successCriterion: 'A recommendation the human judge accepts.',
  convergence: 'human',
  budget: { maxRounds: 2, maxTotalTokens: 400_000, maxCostUsd: 5 },
};

/** The codes of a rejection result — fails loudly if the preset was accepted. */
function issueCodes(preset: CouncilPreset): string[] {
  const result = validateCouncilPreset(preset);
  if (result.valid) throw new Error('expected the preset to be rejected');
  return result.issues.map((issue) => issue.code);
}

describe('validateCouncilPreset', () => {
  test('accepts a well-formed heterogeneous preset', () => {
    expect(validateCouncilPreset(basePreset)).toEqual({ valid: true });
  });

  test('REJECTS homogeneous seats (same model = sycophantic agreement)', () => {
    const homogeneous: CouncilPreset = {
      ...basePreset,
      seats: [
        { id: 'a', role: 'proposer', model: 'claude-opus-4-8' },
        { id: 'b', role: 'critic', model: 'claude-opus-4-8' },
      ],
    };
    expect(issueCodes(homogeneous)).toContain('insufficient-model-diversity');
  });

  test('REJECTS more than four seats', () => {
    const tooMany: CouncilPreset = {
      ...basePreset,
      seats: [
        { id: 'a', role: 'proposer', model: 'claude-opus-4-8' },
        { id: 'b', role: 'proposer', model: 'claude-sonnet-4-6' },
        { id: 'c', role: 'critic', model: 'claude-haiku-4-5' },
        { id: 'd', role: 'critic', model: 'claude-fable-5' },
        { id: 'e', role: 'critic', model: 'claude-opus-4-8' },
      ],
    };
    expect(issueCodes(tooMany)).toContain('too-many-seats');
  });

  test('REJECTS an empty seat list', () => {
    expect(issueCodes({ ...basePreset, seats: [] })).toEqual(
      expect.arrayContaining(['no-seats', 'insufficient-model-diversity']),
    );
  });

  test('REJECTS a seat with the reserved `human` role (verdict-forgery guard, PR #362)', () => {
    const humanSeat: CouncilPreset = {
      ...basePreset,
      seats: [
        { id: 'a', role: 'proposer', model: 'claude-opus-4-8' },
        { id: 'impostor', role: 'human', model: 'claude-sonnet-4-6' },
      ],
    };
    expect(issueCodes(humanSeat)).toContain('reserved-seat-role');
  });

  test('REJECTS a seat with the reserved `conductor` role', () => {
    const conductorSeat: CouncilPreset = {
      ...basePreset,
      seats: [
        { id: 'a', role: 'proposer', model: 'claude-opus-4-8' },
        { id: 'impostor', role: 'conductor', model: 'claude-sonnet-4-6' },
      ],
    };
    expect(issueCodes(conductorSeat)).toContain('reserved-seat-role');
  });

  test('ACCEPTS the debating roles (proposer / critic / judge)', () => {
    const judged: CouncilPreset = {
      ...basePreset,
      seats: [
        { id: 'a', role: 'proposer', model: 'claude-opus-4-8' },
        { id: 'b', role: 'critic', model: 'claude-sonnet-4-6' },
        { id: 'c', role: 'judge', model: 'claude-haiku-4-5' },
      ],
    };
    expect(validateCouncilPreset(judged)).toEqual({ valid: true });
  });

  test('REJECTS a zero budget/round cap', () => {
    const zeroCap: CouncilPreset = {
      ...basePreset,
      budget: { ...basePreset.budget, maxRounds: 0 },
    };
    expect(issueCodes(zeroCap)).toContain('non-positive-budget-cap');
  });

  test('REJECTS a negative cost cap', () => {
    const negativeCost: CouncilPreset = {
      ...basePreset,
      budget: { ...basePreset.budget, maxCostUsd: -1 },
    };
    expect(issueCodes(negativeCost)).toContain('non-positive-budget-cap');
  });

  test('REJECTS a missing budget cap (preset hand-built in TS, bypassing parse)', () => {
    const missingCap = {
      ...basePreset,
      budget: { maxTotalTokens: 400_000, maxCostUsd: 5 },
    } as unknown as CouncilPreset;
    expect(issueCodes(missingCap)).toContain('missing-budget-cap');
  });

  // ── Non-human convergence seat shape (issue #370) ─────────────────────────────

  test('ACCEPTS a judge-agent preset with exactly one judge seat + debaters', () => {
    const judgeAgent: CouncilPreset = {
      ...basePreset,
      convergence: 'judge-agent',
      seats: [
        { id: 'p1', role: 'proposer', model: 'claude-opus-4-8' },
        { id: 'p2', role: 'proposer', model: 'claude-sonnet-4-6' },
        { id: 'j', role: 'judge', model: 'claude-haiku-4-5' },
      ],
    };
    expect(validateCouncilPreset(judgeAgent)).toEqual({ valid: true });
  });

  test('REJECTS judge-agent with no judge seat', () => {
    const noJudge: CouncilPreset = { ...basePreset, convergence: 'judge-agent' };
    expect(issueCodes(noJudge)).toContain('judge-agent-requires-one-judge-seat');
  });

  test('REJECTS judge-agent with two judge seats (ambiguous ruler)', () => {
    const twoJudges: CouncilPreset = {
      ...basePreset,
      convergence: 'judge-agent',
      seats: [
        { id: 'p1', role: 'proposer', model: 'claude-opus-4-8' },
        { id: 'j1', role: 'judge', model: 'claude-sonnet-4-6' },
        { id: 'j2', role: 'judge', model: 'claude-haiku-4-5' },
      ],
    };
    expect(issueCodes(twoJudges)).toContain('judge-agent-requires-one-judge-seat');
  });

  test('REJECTS judge-agent with a judge but no debaters to rule on', () => {
    const judgeOnly: CouncilPreset = {
      ...basePreset,
      convergence: 'judge-agent',
      // Two judge seats would trip the one-judge rule; a single judge + no debaters
      // trips the debaters rule. Use one judge only.
      seats: [{ id: 'j', role: 'judge', model: 'claude-opus-4-8' }],
    };
    const codes = issueCodes(judgeOnly);
    expect(codes).toContain('judge-agent-requires-debaters');
  });

  test('ACCEPTS a vote preset with two+ debating seats', () => {
    const vote: CouncilPreset = { ...basePreset, convergence: 'vote' };
    expect(validateCouncilPreset(vote)).toEqual({ valid: true });
  });

  test('REJECTS a vote preset with fewer than two debating seats', () => {
    const oneVoter: CouncilPreset = {
      ...basePreset,
      convergence: 'vote',
      // A single proposer + a judge → only one DEBATING seat, so no quorum is possible.
      seats: [
        { id: 'p1', role: 'proposer', model: 'claude-opus-4-8' },
        { id: 'j', role: 'judge', model: 'claude-sonnet-4-6' },
      ],
    };
    expect(issueCodes(oneVoter)).toContain('vote-requires-debaters');
  });

  test('a judge seat stays VALID under human convergence (backward-compatible)', () => {
    const humanWithJudge: CouncilPreset = {
      ...basePreset,
      convergence: 'human',
      seats: [
        { id: 'p1', role: 'proposer', model: 'claude-opus-4-8' },
        { id: 'c1', role: 'critic', model: 'claude-sonnet-4-6' },
        { id: 'j', role: 'judge', model: 'claude-haiku-4-5' },
      ],
    };
    expect(validateCouncilPreset(humanWithJudge)).toEqual({ valid: true });
  });
});
