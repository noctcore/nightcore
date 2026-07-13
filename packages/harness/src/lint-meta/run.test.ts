import { describe, expect, test } from 'bun:test';

import { createFakeCtx } from './create-fake-ctx.js';
import { exitCodeFor, reportMetaOutcomes, runMetaRules } from './run.js';
import type { IMetaCtx, IMetaRule, IViolation } from './types.js';

const CTX: IMetaCtx = createFakeCtx({ files: { 'src/x.ts': 'contents' } });

function rule(over: Partial<IMetaRule> & Pick<IMetaRule, 'id' | 'run'>): IMetaRule {
  return { category: 'source-text', description: 'test rule', ...over };
}

const violation = (over: Partial<IViolation> = {}): IViolation => ({
  file: 'src/x.ts',
  rule: 'my-rule',
  message: 'bad thing',
  ...over,
});

describe('runMetaRules — capture, never abort', () => {
  test('a passing rule yields a clean outcome and no critical failure', () => {
    const outcomes = runMetaRules([rule({ id: 'ok', ciCritical: true, run: () => [] })], CTX);
    const report = reportMetaOutcomes(outcomes);
    expect(report).toEqual({ criticalCount: 0, totalViolations: 0, lines: [] });
    expect(exitCodeFor(report)).toBe(0);
  });

  test('a ciCritical violation reds the build with the exact [ERROR] format', () => {
    const outcomes = runMetaRules(
      [rule({ id: 'my-rule', ciCritical: true, run: () => [violation()] })],
      CTX,
    );
    const report = reportMetaOutcomes(outcomes);
    expect(report.lines).toEqual(['[ERROR] my-rule (src/x.ts): bad thing']);
    expect(report.criticalCount).toBe(1);
    expect(report.totalViolations).toBe(1);
    expect(exitCodeFor(report)).toBe(1);
  });

  test('a non-critical violation is [info] and does NOT red the build', () => {
    const outcomes = runMetaRules(
      [rule({ id: 'soft', ciCritical: false, run: () => [violation({ rule: 'soft' })] })],
      CTX,
    );
    const report = reportMetaOutcomes(outcomes);
    expect(report.lines).toEqual(['[info] soft (src/x.ts): bad thing']);
    expect(report.criticalCount).toBe(0);
    expect(report.totalViolations).toBe(1);
    expect(exitCodeFor(report)).toBe(0);
  });

  test('a rule that THROWS is itself a critical failure (fail-safe)', () => {
    const outcomes = runMetaRules(
      [
        rule({
          id: 'boom',
          // deliberately NOT ciCritical: a broken rule reds the build regardless.
          run: () => {
            throw new Error('kaboom');
          },
        }),
      ],
      CTX,
    );
    const report = reportMetaOutcomes(outcomes);
    expect(report.criticalCount).toBe(1);
    expect(report.totalViolations).toBe(0);
    expect(report.lines[0]).toContain('[ERROR] boom: rule threw — kaboom');
    expect(exitCodeFor(report)).toBe(1);
  });

  test('a non-Error throw is still captured and critical', () => {
    const outcomes = runMetaRules(
      [
        rule({
          id: 'weird',
          run: () => {
            throw 'a string';
          },
        }),
      ],
      CTX,
    );
    const report = reportMetaOutcomes(outcomes);
    expect(report.criticalCount).toBe(1);
    expect(report.lines[0]).toContain('a string');
  });

  test('onRule fires once per rule, in order (legibility)', () => {
    const seen: string[] = [];
    runMetaRules(
      [
        rule({ id: 'a', run: () => [] }),
        rule({ id: 'b', run: () => [] }),
      ],
      CTX,
      (r) => seen.push(r.id),
    );
    expect(seen).toEqual(['a', 'b']);
  });

  test('mixed rules aggregate: one critical + one info + one throw = 2 critical, 2 violations', () => {
    const outcomes = runMetaRules(
      [
        rule({ id: 'crit', ciCritical: true, run: () => [violation({ rule: 'crit' })] }),
        rule({ id: 'info', run: () => [violation({ rule: 'info' })] }),
        rule({
          id: 'boom',
          run: () => {
            throw new Error('x');
          },
        }),
      ],
      CTX,
    );
    const report = reportMetaOutcomes(outcomes);
    expect(report.criticalCount).toBe(2);
    expect(report.totalViolations).toBe(2);
    expect(exitCodeFor(report)).toBe(1);
  });
});
