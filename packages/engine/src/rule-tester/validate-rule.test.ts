/// <reference types="bun" />
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

import type { SurfaceQuery } from '@nightcore/contracts';

import { validateRule } from './validate-rule.js';

type ValidateRuleQuery = Extract<SurfaceQuery, { type: 'validate-rule' }>;

/** Absolute path to the real ESLint plugin fixture (a `.ts` module → exercises the
 *  cross-toolchain loader against TypeScript source). */
const PLUGIN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'forbidden-plugin.ts',
);

/** Build a `validate-rule` query with sensible defaults for the fixture rule. */
function makeQuery(overrides: Partial<ValidateRuleQuery> = {}): ValidateRuleQuery {
  return {
    type: 'validate-rule',
    requestId: 'test-req',
    ruleId: 'fixture/no-forbidden',
    rulePath: PLUGIN_PATH,
    ruleName: 'no-forbidden',
    validCases: [],
    invalidCases: [],
    ...overrides,
  };
}

describe('validateRule', () => {
  test('passes when supplied cases match the rule behavior', async () => {
    const result = await validateRule(
      makeQuery({
        validCases: ['const ok = 1;'],
        invalidCases: ['{"code":"const forbidden = 1;","errors":1}'],
      }),
    );

    expect(result.outcome).toBe('passed');
    expect(result.ruleLoaded).toBe(true);
    expect(result.validPassed).toBe(1);
    expect(result.validTotal).toBe(1);
    expect(result.invalidPassed).toBe(1);
    expect(result.invalidTotal).toBe(1);
    expect(result.error).toBeUndefined();
    // An ESLint version diagnostic is reported when the toolchain resolves.
    expect(typeof result.eslintVersion === 'string' || result.eslintVersion === undefined).toBe(
      true,
    );
    expect(result.cases).toHaveLength(2);
    expect(result.cases.every((c) => c.passed)).toBe(true);
  });

  test('a bare invalid string is treated as offending code expecting an error', async () => {
    // No JSON wrapper — the raw source is the `code`, `errors` defaults to 1.
    const result = await validateRule(
      makeQuery({ invalidCases: ['const forbidden = 2;'] }),
    );
    expect(result.outcome).toBe('passed');
    expect(result.invalidPassed).toBe(1);
  });

  test('fails (not throws) when a valid case actually triggers the rule', async () => {
    // Feeding offending code as a VALID case: RuleTester expects zero errors but the
    // rule fires — the case must be reported failed, and the run must NOT crash.
    const result = await validateRule(
      makeQuery({ validCases: ['const forbidden = 1;'] }),
    );

    expect(result.outcome).toBe('failed');
    expect(result.ruleLoaded).toBe(true);
    expect(result.validPassed).toBe(0);
    expect(result.validTotal).toBe(1);
    const failed = result.cases.find((c) => !c.passed);
    expect(failed).toBeDefined();
    expect(typeof failed?.message).toBe('string');
    expect(failed?.message?.length).toBeGreaterThan(0);
  });

  test('probes structurally when no cases are supplied', async () => {
    const result = await validateRule(makeQuery());
    expect(result.outcome).toBe('probed');
    expect(result.ruleLoaded).toBe(true);
    expect(result.cases).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  test('derives the rule name from the rule id when ruleName is omitted', async () => {
    // ruleId last segment `no-forbidden` must resolve inside the plugin `rules` map.
    const result = await validateRule(
      makeQuery({ ruleId: '@fixture/no-forbidden', ruleName: undefined }),
    );
    expect(result.outcome).toBe('probed');
    expect(result.ruleLoaded).toBe(true);
  });

  test('soft-errors (never throws) when the rule module cannot be loaded', async () => {
    const result = await validateRule(
      makeQuery({ rulePath: path.join(path.dirname(PLUGIN_PATH), 'does-not-exist.ts') }),
    );
    expect(result.outcome).toBe('error');
    expect(result.ruleLoaded).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('does-not-exist');
  });

  test('soft-errors when a plugin has no rule under the requested name', async () => {
    const result = await validateRule(
      makeQuery({ ruleName: 'no-such-rule' }),
    );
    expect(result.outcome).toBe('error');
    expect(result.ruleLoaded).toBe(false);
    expect(result.error).toContain('no-such-rule');
  });
});
