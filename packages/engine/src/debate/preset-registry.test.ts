/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { CouncilPresetSchema } from '@nightcore/contracts';

import { electWriter } from './build-writer.js';
import {
  COUNCIL_PRESETS,
  RESEARCH_COUNCIL_PRESET,
  resolveCouncilPreset,
  UI_BUG_COUNCIL_PRESET,
} from './preset-registry.js';
import { validateCouncilPreset } from './preset-validator.js';

describe('council preset registry', () => {
  test('resolves the Research preset by id (round-trips through the registry)', () => {
    expect(resolveCouncilPreset('research')).toBe(RESEARCH_COUNCIL_PRESET);
    expect(COUNCIL_PRESETS.research).toBe(RESEARCH_COUNCIL_PRESET);
  });

  test('resolves the UI-bug preset by id (round-trips through the registry)', () => {
    expect(resolveCouncilPreset('ui-bug')).toBe(UI_BUG_COUNCIL_PRESET);
    expect(COUNCIL_PRESETS['ui-bug']).toBe(UI_BUG_COUNCIL_PRESET);
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

  test('the UI-bug preset is a reproduce-first, build-then-gate council (issue #367)', () => {
    // Reproduce-first: the stage sequence adds a `build` between Debate and Converge, and
    // the objective gate is the `repro` (red → green) terminal judge.
    expect(UI_BUG_COUNCIL_PRESET.objectiveGate).toBe('repro');
    expect(UI_BUG_COUNCIL_PRESET.convergence).toBe('human');
    expect(UI_BUG_COUNCIL_PRESET.stages.map((stage) => stage.stage)).toEqual([
      'frame',
      'propose',
      'debate',
      'build',
      'converge',
    ]);
    // The Build's single writer is elected from the proposers, never the critic — the
    // reproduce-first fix has one author (safety #5/#1).
    const seats = UI_BUG_COUNCIL_PRESET.seats.map((s) => ({
      seatId: s.id,
      role: s.role,
      model: s.model,
    }));
    expect(electWriter(seats)?.role).toBe('proposer');
  });
});
