/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { CouncilPresetSchema } from '@nightcore/contracts';

import {
  COUNCIL_PRESETS,
  RESEARCH_COUNCIL_PRESET,
  resolveCouncilPreset,
} from './preset-registry.js';
import { validateCouncilPreset } from './preset-validator.js';

describe('council preset registry', () => {
  test('resolves the Research preset by id (round-trips through the registry)', () => {
    expect(resolveCouncilPreset('research')).toBe(RESEARCH_COUNCIL_PRESET);
    expect(COUNCIL_PRESETS.research).toBe(RESEARCH_COUNCIL_PRESET);
  });

  test('every registered preset is structurally valid (parses through the contract)', () => {
    for (const preset of Object.values(COUNCIL_PRESETS)) {
      expect(CouncilPresetSchema.safeParse(preset).success).toBe(true);
    }
  });

  test('every registered preset satisfies the P1 invariants', () => {
    for (const preset of Object.values(COUNCIL_PRESETS)) {
      expect(validateCouncilPreset(preset)).toEqual({ valid: true });
    }
  });

  test('the Research preset is a blind-propose, human-converged council', () => {
    expect(RESEARCH_COUNCIL_PRESET.convergence).toBe('human');
    expect(RESEARCH_COUNCIL_PRESET.stages.map((stage) => stage.stage)).toEqual([
      'frame',
      'propose',
      'debate',
      'converge',
    ]);
    const propose = RESEARCH_COUNCIL_PRESET.stages.find(
      (stage) => stage.stage === 'propose',
    );
    expect(propose?.blind).toBe(true);
    const debate = RESEARCH_COUNCIL_PRESET.stages.find(
      (stage) => stage.stage === 'debate',
    );
    expect(debate?.maxRounds).toBe(2);
  });
});
