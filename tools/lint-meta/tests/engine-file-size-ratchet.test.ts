/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { engineFileSizeRatchetRule } from '../rules/engine-file-size-ratchet.ts';
import { createFakeCtx, type FakeFiles } from './test-utils/createFakeCtx.ts';

/**
 * Unit tests for `engine-file-size-ratchet` (issue #232), exercising the rule
 * against a synthetic packages/engine tree via the fake IMetaCtx. Proves the
 * three ratchet behaviours: a new over-cap file fails, a grandfathered file
 * passes, and a grandfathered file that grew past its frozen size fails.
 */

const BASELINE_PATH = 'tools/lint-meta/baselines/engine-file-size-ratchet.json';

/** A file body of exactly `n` raw physical lines (`countLines` semantics). */
function lines(n: number): string {
  return Array.from({ length: n }, () => 'x').join('\n');
}

function ctxWith(files: FakeFiles, baseline: Record<string, number>) {
  return createFakeCtx({
    files: { ...files, [BASELINE_PATH]: JSON.stringify(baseline) },
  });
}

describe('engineFileSizeRatchetRule (via fake ctx)', () => {
  test('an under-cap engine file reports zero violations', () => {
    const ctx = ctxWith(
      { 'packages/engine/src/small.ts': lines(120) },
      {},
    );
    expect(engineFileSizeRatchetRule.run(ctx)).toEqual([]);
  });

  test('a file over cap NOT in the baseline fails', () => {
    const ctx = ctxWith(
      { 'packages/engine/src/scans/huge.ts': lines(500) },
      {},
    );
    const violations = engineFileSizeRatchetRule.run(ctx);
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('engine-file-size-ratchet');
    expect(violations[0].file).toBe('packages/engine/src/scans/huge.ts');
    expect(violations[0].message).toContain('exceeds the 400-line cap');
  });

  test('a baselined file within its frozen size passes (grandfathered)', () => {
    const file = 'packages/engine/src/policy/legacy.ts';
    const ctx = ctxWith({ [file]: lines(450) }, { [file]: 450 });
    expect(engineFileSizeRatchetRule.run(ctx)).toEqual([]);
  });

  test('a baselined file that GREW beyond its frozen size fails', () => {
    const file = 'packages/engine/src/policy/legacy.ts';
    const ctx = ctxWith({ [file]: lines(500) }, { [file]: 450 });
    const violations = engineFileSizeRatchetRule.run(ctx);
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe(file);
    expect(violations[0].message).toContain('exceeds the 400-line cap');
  });

  test('tests/specs/stories under engine src are excluded', () => {
    const ctx = ctxWith(
      {
        'packages/engine/src/foo.test.ts': lines(900),
        'packages/engine/src/foo.spec.ts': lines(900),
        'packages/engine/src/foo.stories.ts': lines(900),
      },
      {},
    );
    expect(engineFileSizeRatchetRule.run(ctx)).toEqual([]);
  });

  test('a stale baseline entry (file now within cap) demands tightening', () => {
    const file = 'packages/engine/src/policy/shrunk.ts';
    const ctx = ctxWith({ [file]: lines(120) }, { [file]: 450 });
    const violations = engineFileSizeRatchetRule.run(ctx);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain('update-baseline');
  });
});
