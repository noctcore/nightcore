import { describe, expect, test } from 'bun:test';

import { createFakeCtx } from './create-fake-ctx.js';
import { exitCodeFor, reportMetaOutcomes, runMetaRules } from './run.js';
import type { IMetaCtx, IMetaRule, IViolation } from './types.js';

const CTX: IMetaCtx = createFakeCtx({ files: { 'src/x.ts': 'contents' } });

function rule(over: Partial<IMetaRule> & Pick<IMetaRule, 'id'>): IMetaRule {
  return { category: 'source-text', description: 'test rule', ...over };
}

const violation = (over: Partial<IViolation> = {}): IViolation => ({
  file: 'src/x.ts',
  rule: 'my-rule',
  message: 'bad thing',
  ...over,
});

describe('runMetaRules — capture, never abort', () => {
  test('a passing rule yields a clean outcome and no critical failure', async () => {
    const outcomes = await runMetaRules([rule({ id: 'ok', ciCritical: true, run: () => [] })], CTX);
    const report = reportMetaOutcomes(outcomes);
    expect(report).toEqual({ criticalCount: 0, totalViolations: 0, lines: [] });
    expect(exitCodeFor(report)).toBe(0);
  });

  test('a ciCritical violation reds the build with the exact [ERROR] format', async () => {
    const outcomes = await runMetaRules(
      [rule({ id: 'my-rule', ciCritical: true, run: () => [violation()] })],
      CTX,
    );
    const report = reportMetaOutcomes(outcomes);
    expect(report.lines).toEqual(['[ERROR] my-rule (src/x.ts): bad thing']);
    expect(report.criticalCount).toBe(1);
    expect(report.totalViolations).toBe(1);
    expect(exitCodeFor(report)).toBe(1);
  });

  test('a non-critical violation is [info] and does NOT red the build', async () => {
    const outcomes = await runMetaRules(
      [rule({ id: 'soft', ciCritical: false, run: () => [violation({ rule: 'soft' })] })],
      CTX,
    );
    const report = reportMetaOutcomes(outcomes);
    expect(report.lines).toEqual(['[info] soft (src/x.ts): bad thing']);
    expect(report.criticalCount).toBe(0);
    expect(report.totalViolations).toBe(1);
    expect(exitCodeFor(report)).toBe(0);
  });

  test('a rule that THROWS is itself a critical failure (fail-safe)', async () => {
    const outcomes = await runMetaRules(
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

  test('a non-Error throw is still captured and critical', async () => {
    const outcomes = await runMetaRules(
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

  test('onRule fires once per rule, in order (legibility)', async () => {
    const seen: string[] = [];
    await runMetaRules(
      [
        rule({ id: 'a', run: () => [] }),
        rule({ id: 'b', run: () => [] }),
      ],
      CTX,
      (r) => seen.push(r.id),
    );
    expect(seen).toEqual(['a', 'b']);
  });

  test('mixed rules aggregate: one critical + one info + one throw = 2 critical, 2 violations', async () => {
    const outcomes = await runMetaRules(
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

describe('runMetaRules: async rules (runAsync)', () => {
  test('an async-only rule runs and its violations are reported', async () => {
    const outcomes = await runMetaRules(
      [
        rule({
          id: 'later',
          ciCritical: true,
          runAsync: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return [violation({ rule: 'later' })];
          },
        }),
      ],
      CTX,
    );
    const report = reportMetaOutcomes(outcomes);
    expect(outcomes.map((o) => o.pass)).toEqual(['async']);
    expect(report.lines).toEqual(['[ERROR] later (src/x.ts): bad thing']);
    expect(exitCodeFor(report)).toBe(1);
  });

  test('a rejecting rule is isolated: it reds the build and the rules after it still report', async () => {
    const outcomes = await runMetaRules(
      [
        rule({ id: 'broken', runAsync: () => Promise.reject(new Error('async rule blew up')) }),
        rule({
          id: 'still-runs',
          ciCritical: true,
          runAsync: () => Promise.resolve([violation({ rule: 'still-runs' })]),
        }),
        rule({ id: 'sync-after', ciCritical: true, run: () => [violation({ rule: 'sync-after' })] }),
      ],
      CTX,
    );
    const report = reportMetaOutcomes(outcomes);
    expect(outcomes[0]?.threw).toBe('async rule blew up');
    expect(report.lines).toEqual([
      '[ERROR] broken: rule rejected — async rule blew up',
      '[ERROR] still-runs (src/x.ts): bad thing',
      '[ERROR] sync-after (src/x.ts): bad thing',
    ]);
    expect(report.criticalCount).toBe(3);
  });

  test('a runAsync that throws synchronously is caught the same way', async () => {
    const outcomes = await runMetaRules(
      [
        rule({
          id: 'eager',
          runAsync: () => {
            throw new Error('before the promise');
          },
        }),
        rule({ id: 'next', runAsync: () => Promise.resolve([]) }),
      ],
      CTX,
    );
    expect(outcomes.map((o) => [o.id, o.threw])).toEqual([
      ['eager', 'before the promise'],
      ['next', null],
    ]);
  });

  test('a rule with both entry points runs both, sync first, one outcome per pass', async () => {
    const order: string[] = [];
    const outcomes = await runMetaRules(
      [
        rule({
          id: 'both',
          ciCritical: true,
          run: () => {
            order.push('sync');
            return [violation({ rule: 'both', message: 'from run' })];
          },
          runAsync: () => {
            order.push('async');
            return Promise.resolve([violation({ rule: 'both', message: 'from runAsync' })]);
          },
        }),
      ],
      CTX,
    );
    expect(order).toEqual(['sync', 'async']);
    expect(outcomes.map((o) => o.pass)).toEqual(['sync', 'async']);
    expect(reportMetaOutcomes(outcomes).lines).toEqual([
      '[ERROR] both (src/x.ts): from run',
      '[ERROR] both (src/x.ts): from runAsync',
    ]);
  });

  test('a sync pass that throws does not skip the same rule\'s async pass', async () => {
    const outcomes = await runMetaRules(
      [
        rule({
          id: 'half',
          run: () => {
            throw new Error('sync half broke');
          },
          runAsync: () => Promise.resolve([violation({ rule: 'half' })]),
        }),
      ],
      CTX,
    );
    expect(outcomes.map((o) => [o.pass, o.threw, o.violations.length])).toEqual([
      ['sync', 'sync half broke', 0],
      ['async', null, 1],
    ]);
  });

  test('a sync run() that returns a Promise is a named failure, not a crash', async () => {
    const misdeclared = {
      id: 'misdeclared',
      category: 'config',
      description: 'async work under the sync entry point',
      run: () => Promise.resolve([]),
    } as unknown as IMetaRule;
    const outcomes = await runMetaRules([misdeclared, rule({ id: 'after', run: () => [] })], CTX);
    expect(outcomes[0]?.threw).toContain('declare an async rule as runAsync(ctx)');
    expect(outcomes[1]).toMatchObject({ id: 'after', threw: null });
    expect(exitCodeFor(reportMetaOutcomes(outcomes))).toBe(1);
  });

  test('a runAsync that resolves to a non-array is a named failure', async () => {
    const bad = {
      id: 'bad-shape',
      category: 'config',
      description: 'resolves to the wrong thing',
      runAsync: () => Promise.resolve(undefined),
    } as unknown as IMetaRule;
    const outcomes = await runMetaRules([bad], CTX);
    expect(outcomes[0]?.threw).toBe('runAsync() must return an array of violations, got undefined');
  });

  test('onRule fires once per rule even when the rule has both passes', async () => {
    const seen: string[] = [];
    await runMetaRules(
      [rule({ id: 'both', run: () => [], runAsync: () => Promise.resolve([]) })],
      CTX,
      (r) => seen.push(r.id),
    );
    expect(seen).toEqual(['both']);
  });

  test('existing sync verdicts and exit codes are unchanged', async () => {
    const report = reportMetaOutcomes(
      await runMetaRules([rule({ id: 'soft', run: () => [violation({ rule: 'soft' })] })], CTX),
    );
    expect(report.lines).toEqual(['[info] soft (src/x.ts): bad thing']);
    expect(exitCodeFor(report)).toBe(0);
  });
});
