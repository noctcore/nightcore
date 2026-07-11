/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { buildJsonReport, type RuleOutcome } from '../json-reporter.ts';
import { packageShapeRule } from '../rules/package-shape.ts';
import type { IViolation } from '../types.ts';
import { createFakeCtx, type FakeFiles } from './test-utils/createFakeCtx.ts';

/**
 * Contract tests for the `--json` machine-readable reporter (Drift v1 slice 3).
 * `buildJsonReport` is pure, so these feed it synthetic outcomes AND one real rule
 * run against a fake ctx — the exact path the CLI folds over.
 */

const v = (rule: string, file: string, message = 'boom'): IViolation => ({
  rule,
  file,
  message,
});

describe('buildJsonReport — shape + counts', () => {
  test('N=3 violations across M=2 files → flat list, per-rule counts, total', () => {
    // rule-a: 2 violations (file1, file2); rule-b: 1 violation (file2).
    const outcomes: RuleOutcome[] = [
      {
        id: 'rule-a',
        error: null,
        violations: [v('rule-a', 'src/one.ts'), v('rule-a', 'src/two.ts')],
      },
      { id: 'rule-b', error: null, violations: [v('rule-b', 'src/two.ts')] },
    ];

    const report = buildJsonReport(outcomes);

    expect(report.violations).toHaveLength(3);
    expect(report.counts).toEqual({ 'rule-a': 2, 'rule-b': 1 });
    expect(report.total).toBe(3);
    expect(report.errored).toEqual([]);

    // M=2 distinct files across the flat list.
    const files = new Set(report.violations.map((x) => x.filePath));
    expect(files.size).toBe(2);

    // Field mapping: rule→ruleId, file→filePath, message passthrough.
    expect(report.violations[0]).toEqual({
      ruleId: 'rule-a',
      filePath: 'src/one.ts',
      message: 'boom',
    });
  });

  test('total always equals violations.length (counts sum invariant)', () => {
    const outcomes: RuleOutcome[] = [
      { id: 'a', error: null, violations: [v('a', 'f1'), v('a', 'f2')] },
      { id: 'b', error: null, violations: [] },
      { id: 'c', error: null, violations: [v('c', 'f3')] },
    ];
    const report = buildJsonReport(outcomes);
    expect(report.total).toBe(report.violations.length);
    expect(report.total).toBe(3);
  });

  test('a rule that ran clean is present in counts as 0 (distinct from absent/errored)', () => {
    const report = buildJsonReport([{ id: 'clean-rule', error: null, violations: [] }]);
    expect(report.counts).toEqual({ 'clean-rule': 0 });
    expect(report.violations).toEqual([]);
    expect(report.total).toBe(0);
  });
});

describe('buildJsonReport — line/column', () => {
  test('includes line/column when the rule reports a location', () => {
    const located: IViolation = {
      rule: 'r',
      file: 'src/a.ts',
      message: 'here',
      line: 12,
      column: 3,
    };
    const report = buildJsonReport([{ id: 'r', error: null, violations: [located] }]);
    expect(report.violations[0]).toEqual({
      ruleId: 'r',
      filePath: 'src/a.ts',
      message: 'here',
      line: 12,
      column: 3,
    });
  });

  test('omits line/column entirely (never null) when absent', () => {
    const report = buildJsonReport([
      { id: 'r', error: null, violations: [v('r', 'src/a.ts')] },
    ]);
    const entry = report.violations[0];
    expect('line' in entry).toBe(false);
    expect('column' in entry).toBe(false);
    // JSON round-trip carries no null keys that would break a count.
    expect(JSON.parse(JSON.stringify(entry))).toEqual({
      ruleId: 'r',
      filePath: 'src/a.ts',
      message: 'boom',
    });
  });

  test('line without column is surfaced independently', () => {
    const partial: IViolation = { rule: 'r', file: 'f', message: 'm', line: 5 };
    const report = buildJsonReport([{ id: 'r', error: null, violations: [partial] }]);
    expect(report.violations[0].line).toBe(5);
    expect('column' in report.violations[0]).toBe(false);
  });
});

describe('buildJsonReport — errored rules (fail-visible)', () => {
  test('a thrown rule is listed in errored, excluded from counts + total', () => {
    const outcomes: RuleOutcome[] = [
      { id: 'ok', error: null, violations: [v('ok', 'f1')] },
      { id: 'boom', error: 'Error: kaboom', violations: [] },
    ];
    const report = buildJsonReport(outcomes);
    expect(report.errored).toEqual(['boom']);
    expect(report.counts).toEqual({ ok: 1 }); // 'boom' NOT present
    expect(report.total).toBe(1);
    expect(report.violations).toHaveLength(1);
  });
});

describe('buildJsonReport — end-to-end with a real rule', () => {
  test('packageShapeRule violations across M files fold into the report', () => {
    // Two malformed packages → known violations across two package.json files.
    const files: FakeFiles = {
      'packages/bad/package.json': JSON.stringify({ name: '@wrong/bad' }),
      'packages/bad/src/index.ts': '',
      'packages/nobarrel/package.json': JSON.stringify({
        name: '@nightcore/nobarrel',
        main: './dist/index.js',
        module: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': './dist/index.js' },
      }),
      // packages/nobarrel has no src/index.ts → missing-barrel violation.
    };
    const ctx = createFakeCtx({ files });
    const violations = packageShapeRule.run(ctx);
    expect(violations.length).toBeGreaterThan(0);

    const report = buildJsonReport([
      { id: packageShapeRule.id, error: null, violations },
    ]);

    expect(report.counts[packageShapeRule.id]).toBe(violations.length);
    expect(report.total).toBe(violations.length);
    expect(report.errored).toEqual([]);
    for (const entry of report.violations) {
      expect(entry.ruleId).toBe('package-shape');
      expect(typeof entry.filePath).toBe('string');
      expect(typeof entry.message).toBe('string');
    }
  });
});
