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
});
