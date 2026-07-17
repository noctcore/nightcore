/// <reference types="bun" />
/**
 * The OBJECTIVE-PRESET resolver (issue #367, P2) — the SHARED preset-aware gate builder the
 * UI-bug preset (#367) and Coding preset (#368) reuse. Driven with a deterministic fake
 * gauntlet runner, never a live spawn (the exec belongs to the gauntlet, mirroring
 * `objective-gate.test.ts`).
 */
import { describe, expect, test } from 'bun:test';

import type { CouncilPreset } from '@nightcore/contracts';

import type {
  GauntletLikeResult,
  ObjectiveGateContext,
} from './objective-gate.js';
import { isObjectivePreset, objectiveGateForPreset } from './objective-preset.js';
import {
  RESEARCH_COUNCIL_PRESET,
  UI_BUG_COUNCIL_PRESET,
} from './preset-registry.js';

function context(): ObjectiveGateContext {
  return {
    councilRunId: 'run-ui',
    objective: 'fix the broken button',
    successCriterion: 'the repro goes RED → GREEN',
    cwd: '/project/.nightcore/worktrees/run-ui',
    positions: [{ seatId: 'proposer-opus', role: 'proposer', content: 'apply fix X' }],
    signal: new AbortController().signal,
  };
}

/** A fake gauntlet runner — the injected repro exec. */
function reproRunner(green: boolean): (ctx: ObjectiveGateContext) => GauntletLikeResult {
  return () =>
    green
      ? { passed: true, checks: [{ name: 'repro', status: 'passed' }] }
      : {
          passed: false,
          failedCheck: 'repro',
          checks: [{ name: 'repro', status: 'failed', output: 'repro still RED' }],
        };
}

describe('isObjectivePreset', () => {
  test('the UI-bug preset is objective; the Research preset is not', () => {
    expect(isObjectivePreset(UI_BUG_COUNCIL_PRESET)).toBe(true);
    expect(isObjectivePreset(RESEARCH_COUNCIL_PRESET)).toBe(false);
  });
});

describe('objectiveGateForPreset — data-driven gate resolution', () => {
  test('a pure-reasoning preset (no objectiveGate marker) resolves NO gate', () => {
    const gate = objectiveGateForPreset(RESEARCH_COUNCIL_PRESET, reproRunner(true));
    expect(gate).toBeUndefined();
  });

  test('no injected gauntlet runner ⇒ no gate (the DORMANT production state)', () => {
    const gate = objectiveGateForPreset(UI_BUG_COUNCIL_PRESET, undefined);
    expect(gate).toBeUndefined();
  });

  test("the `repro` gate maps a RED repro to a FAILED verdict (overrides consensus)", async () => {
    const gate = objectiveGateForPreset(UI_BUG_COUNCIL_PRESET, reproRunner(false));
    expect(gate).toBeDefined();
    const verdict = await gate!.evaluate(context());
    expect(verdict.passed).toBe(false);
    expect(verdict.summary).toContain('FAILED');
    expect(verdict.checks?.some((c) => !c.passed && c.name === 'repro')).toBe(true);
  });

  test('the `repro` gate maps a GREEN repro to a PASSED verdict', async () => {
    const gate = objectiveGateForPreset(UI_BUG_COUNCIL_PRESET, reproRunner(true));
    const verdict = await gate!.evaluate(context());
    expect(verdict.passed).toBe(true);
    expect(verdict.summary).toContain('passed');
  });

  test('the injected runner receives the gate context (so it runs in the build worktree)', async () => {
    let seen: ObjectiveGateContext | undefined;
    const gate = objectiveGateForPreset(UI_BUG_COUNCIL_PRESET, (ctx): GauntletLikeResult => {
      seen = ctx;
      return { passed: true, checks: [] };
    });
    await gate!.evaluate(context());
    expect(seen?.cwd).toBe('/project/.nightcore/worktrees/run-ui');
    expect(seen?.councilRunId).toBe('run-ui');
  });

  test('a hand-built preset with no build stage still resolves its gate (validator owns that invariant)', () => {
    // The resolver is DATA-DRIVEN off the marker alone; the build ⟺ gate coupling is a
    // validation concern (`validateCouncilPreset`), not the resolver's — so a marker present
    // resolves a gate regardless of stages.
    const noBuild: CouncilPreset = { ...RESEARCH_COUNCIL_PRESET, objectiveGate: 'repro' };
    expect(objectiveGateForPreset(noBuild, reproRunner(true))).toBeDefined();
  });
});
