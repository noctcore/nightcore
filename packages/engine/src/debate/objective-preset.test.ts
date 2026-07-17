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
  CODING_COUNCIL_PRESET,
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

/** A fake build/test gauntlet runner — the injected typecheck/lint/test exec (#368). */
function buildRunner(green: boolean): (ctx: ObjectiveGateContext) => GauntletLikeResult {
  return () =>
    green
      ? {
          passed: true,
          checks: [
            { name: 'typecheck', status: 'passed' },
            { name: 'test', status: 'passed' },
          ],
        }
      : {
          passed: false,
          failedCheck: 'test',
          checks: [
            { name: 'typecheck', status: 'passed' },
            { name: 'test', status: 'failed', output: '2 tests fail' },
          ],
        };
}

describe('isObjectivePreset', () => {
  test('the UI-bug + Coding presets are objective; the Research preset is not', () => {
    expect(isObjectivePreset(UI_BUG_COUNCIL_PRESET)).toBe(true);
    expect(isObjectivePreset(CODING_COUNCIL_PRESET)).toBe(true);
    expect(isObjectivePreset(RESEARCH_COUNCIL_PRESET)).toBe(false);
  });
});

describe('objectiveGateForPreset — data-driven gate resolution', () => {
  test('a pure-reasoning preset (no objectiveGate marker) resolves NO gate', () => {
    const gate = objectiveGateForPreset(RESEARCH_COUNCIL_PRESET, reproRunner(true));
    expect(gate).toBeUndefined();
  });

  test('no injected gauntlet runner ⇒ no gate (defensive degrade — production DOES inject one)', () => {
    // Production now injects the runner (the driver shipped in #383/#386), so a build-capable
    // council gates for real. This guards the DEGRADE path: with no runner there is nothing to
    // run, so the resolver returns no gate rather than a gate that would throw at evaluate.
    const gate = objectiveGateForPreset(UI_BUG_COUNCIL_PRESET, undefined);
    expect(gate).toBeUndefined();
  });

  test('an UNHANDLED objective-gate kind THROWS — fail-CLOSED backstop (issue #385)', () => {
    // A future `CouncilObjectiveGate` kind reaching the resolver without a case is a COMPILE
    // error (`kind` narrows to `never`); this exercises the runtime backstop should an
    // un-typed value ever slip in. It MUST throw, not silently return `undefined` — an absent
    // gate = the terminal deterministic judge never runs (fail-OPEN on safety #6).
    const bogus = {
      ...UI_BUG_COUNCIL_PRESET,
      objectiveGate: 'teleport',
    } as unknown as CouncilPreset;
    expect(() => objectiveGateForPreset(bogus, reproRunner(true))).toThrow(
      /unhandled council objective-gate kind/,
    );
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

  test('the Coding preset resolves the `build` gate — a RED build/test overrides consensus (#368)', async () => {
    const gate = objectiveGateForPreset(CODING_COUNCIL_PRESET, buildRunner(false));
    expect(gate).toBeDefined();
    const verdict = await gate!.evaluate(context());
    // A red build/test FAILS the gate: the plan compiled/ran but the suite is red, so
    // consensus cannot be adopted over it (safety #6 — the gate decides, not the debate).
    expect(verdict.passed).toBe(false);
    expect(verdict.summary).toContain('FAILED');
    expect(verdict.checks?.some((c) => !c.passed && c.name === 'test')).toBe(true);
  });

  test('the Coding preset `build` gate maps a GREEN build/test to a PASSED verdict (#368)', async () => {
    const gate = objectiveGateForPreset(CODING_COUNCIL_PRESET, buildRunner(true));
    const verdict = await gate!.evaluate(context());
    expect(verdict.passed).toBe(true);
    expect(verdict.summary).toContain('passed');
  });

  test('no injected gauntlet runner ⇒ the Coding preset resolves NO gate (defensive degrade)', () => {
    // Symmetry with the UI-bug degrade case: with no runner there is nothing to run, so the
    // resolver returns no gate rather than one that would throw at evaluate. Production injects
    // the runner (the write-capable driver shipped in #383/#386).
    expect(objectiveGateForPreset(CODING_COUNCIL_PRESET, undefined)).toBeUndefined();
  });
});
