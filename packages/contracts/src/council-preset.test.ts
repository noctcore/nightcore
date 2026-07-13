/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  CouncilBudgetSchema,
  CouncilPresetIdSchema,
  CouncilPresetSchema,
} from './council-preset.js';

describe('CouncilPresetIdSchema', () => {
  test('accepts the P1 `research` id and rejects unknown ids', () => {
    expect(CouncilPresetIdSchema.parse('research')).toBe('research');
    expect(CouncilPresetIdSchema.safeParse('coding').success).toBe(false);
  });
});

describe('CouncilPresetSchema', () => {
  const validPreset = {
    id: 'research' as const,
    label: 'Research council',
    seats: [
      { id: 'a', role: 'proposer' as const, model: 'claude-opus-4-8' },
      { id: 'b', role: 'critic' as const, model: 'claude-sonnet-4-6' },
    ],
    stages: [
      { stage: 'frame' as const },
      { stage: 'propose' as const, blind: true },
      { stage: 'debate' as const, maxRounds: 2 },
      { stage: 'converge' as const },
    ],
    routing: { mode: 'moderated-bus' as const },
    successCriterion: 'A recommendation the human judge accepts.',
    convergence: 'human' as const,
    budget: { maxRounds: 2, maxTotalTokens: 400_000, maxCostUsd: 5 },
  };

  test('parses a well-formed preset and applies stage/routing defaults', () => {
    const parsed = CouncilPresetSchema.parse(validPreset);
    // `blind` defaults to false where omitted; the explicit `true` is preserved.
    expect(parsed.stages.map((s) => s.blind)).toEqual([false, true, false, false]);
    // `routing.edges` defaults to an empty list.
    expect(parsed.routing.edges).toEqual([]);
  });

  test('reuses the debate role/stage vocabulary (rejects a foreign role)', () => {
    const badRole = {
      ...validPreset,
      seats: [{ id: 'a', role: 'saboteur', model: 'claude-opus-4-8' }],
    };
    expect(CouncilPresetSchema.safeParse(badRole).success).toBe(false);
  });

  test('leaves the schema open for judge/vote convergence', () => {
    expect(
      CouncilPresetSchema.safeParse({ ...validPreset, convergence: 'judge' })
        .success,
    ).toBe(true);
    expect(
      CouncilPresetSchema.safeParse({ ...validPreset, convergence: 'vote' })
        .success,
    ).toBe(true);
  });
});

describe('CouncilBudgetSchema', () => {
  test('requires positive caps at the structural (parse) boundary', () => {
    expect(
      CouncilBudgetSchema.safeParse({
        maxRounds: 0,
        maxTotalTokens: 1,
        maxCostUsd: 1,
      }).success,
    ).toBe(false);
    expect(
      CouncilBudgetSchema.safeParse({
        maxRounds: 1,
        maxTotalTokens: 1,
        maxCostUsd: 1,
      }).success,
    ).toBe(true);
  });
});
