/// <reference types="bun" />
import { describe, expect, mock, test } from 'bun:test';

import type { Logger } from '@nightcore/shared';

import {
  BASH_COMMAND_SCAN_LIMIT,
  compileBashRules,
  matchBashRule,
  MAX_BASH_PATTERN_LENGTH,
} from './bash-rules.js';

function fakeLogger(): Logger {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  } as unknown as Logger;
}

describe('compileBashRules', () => {
  test('patterns are compiled as real regexes', () => {
    const rules = compileBashRules(['npm\\s+install\\s+(?!--package-lock-only)']);
    expect(rules).toHaveLength(1);
    expect(matchBashRule('npm install left-pad', rules)?.pattern).toBe(
      'npm\\s+install\\s+(?!--package-lock-only)',
    );
    expect(matchBashRule('npm install --package-lock-only', rules)).toBeUndefined();
  });

  test('an invalid regex is warn-and-skipped; valid patterns still compile', () => {
    const logger = fakeLogger();
    const rules = compileBashRules(['(unclosed', '--no-verify'], logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.pattern).toBe('--no-verify');
  });

  test('a pattern over MAX_BASH_PATTERN_LENGTH is warn-and-skipped', () => {
    const logger = fakeLogger();
    const oversized = 'a'.repeat(MAX_BASH_PATTERN_LENGTH + 1);
    const rules = compileBashRules([oversized, '--no-verify'], logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(rules).toHaveLength(1);
  });

  test('a pattern exactly at the cap still compiles', () => {
    const rules = compileBashRules(['b'.repeat(MAX_BASH_PATTERN_LENGTH)]);
    expect(rules).toHaveLength(1);
  });
});

describe('matchBashRule — command scan cap', () => {
  test('only the first BASH_COMMAND_SCAN_LIMIT chars are tested', () => {
    const rules = compileBashRules(['--no-verify']);
    const pastCap = `${'x'.repeat(BASH_COMMAND_SCAN_LIMIT)} --no-verify`;
    expect(matchBashRule(pastCap, rules)).toBeUndefined();
    const withinCap = `--no-verify ${'x'.repeat(BASH_COMMAND_SCAN_LIMIT)}`;
    expect(matchBashRule(withinCap, rules)?.pattern).toBe('--no-verify');
  });

  test('a match straddling the cap boundary does not fire (sliced input)', () => {
    const rules = compileBashRules(['--no-verify']);
    const prefix = 'y'.repeat(BASH_COMMAND_SCAN_LIMIT - 4);
    expect(matchBashRule(`${prefix}--no-verify`, rules)).toBeUndefined();
  });

  test('the first matching rule wins', () => {
    const rules = compileBashRules(['--no-verify', 'git commit']);
    expect(matchBashRule('git commit --no-verify', rules)?.pattern).toBe('--no-verify');
  });

  test('no match returns undefined', () => {
    const rules = compileBashRules(['--no-verify']);
    expect(matchBashRule('git commit -m "ok"', rules)).toBeUndefined();
  });
});
