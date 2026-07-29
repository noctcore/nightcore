/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  bashPatternMatches,
  compileBashPattern,
  compilePathRule,
  compileToolEntries,
  firstMatchingPathRule,
  isMcpGlobEntry,
  MANIFEST_PROTECTED_PATTERN,
  MAX_BASH_PATTERN_LENGTH,
  pathSegments,
  ruleProtects,
  toolMatches,
} from './policy-patterns.js';

/** Compile-or-fail helper: every pattern in these tests is meant to be usable. */
function rule(pattern: string) {
  const compiled = compilePathRule(pattern);
  expect(compiled).toBeDefined();
  return compiled!;
}

describe('compilePathRule', () => {
  test('rejects an empty or separator-only pattern', () => {
    expect(compilePathRule('')).toBeUndefined();
    expect(compilePathRule('   ')).toBeUndefined();
    expect(compilePathRule('/')).toBeUndefined();
  });

  test('treats a pattern without a separator as floating', () => {
    expect(rule('*.lock').floating).toBe(true);
    expect(rule('migrations/**').floating).toBe(false);
  });

  test('tolerates leading ./ and trailing / as author sugar', () => {
    expect(ruleProtects(rule('./migrations/'), pathSegments('migrations/001.sql'))).toBe(true);
    expect(ruleProtects(rule('/migrations'), pathSegments('migrations/001.sql'))).toBe(true);
  });
});

describe('ruleProtects', () => {
  test('* matches within one segment only', () => {
    const r = rule('src/*.ts');
    expect(ruleProtects(r, pathSegments('src/main.ts'))).toBe(true);
    expect(ruleProtects(r, pathSegments('src/deep/main.ts'))).toBe(false);
  });

  test('** spans zero or more segments', () => {
    const r = rule('src/**/*.ts');
    expect(ruleProtects(r, pathSegments('src/main.ts'))).toBe(true);
    expect(ruleProtects(r, pathSegments('src/a/b/main.ts'))).toBe(true);
  });

  test('a floating pattern matches at any depth', () => {
    const r = rule('*.lock');
    expect(ruleProtects(r, pathSegments('bun.lock'))).toBe(true);
    expect(ruleProtects(r, pathSegments('apps/web/bun.lock'))).toBe(true);
  });

  test('a matched prefix protects the whole subtree', () => {
    const r = rule('migrations');
    expect(ruleProtects(r, pathSegments('migrations/2026/001.sql'))).toBe(true);
  });

  test('matching folds case (a case-variant write lands in the same file)', () => {
    expect(ruleProtects(rule('Migrations/**'), pathSegments('migrations/001.sql'))).toBe(true);
  });

  test('the self-protection pattern covers the manifest', () => {
    const r = rule(MANIFEST_PROTECTED_PATTERN);
    expect(ruleProtects(r, pathSegments('.nightcore/harness.json'))).toBe(true);
    expect(ruleProtects(r, pathSegments('nightcore/harness.json'))).toBe(false);
  });

  test('unsupported glob syntax matches literally (the silently-dead rule #400 warns about)', () => {
    const r = rule('migrations/{a,b}');
    expect(ruleProtects(r, pathSegments('migrations/a'))).toBe(false);
    expect(ruleProtects(r, pathSegments('migrations/{a,b}'))).toBe(true);
  });
});

describe('pathSegments', () => {
  test('accepts either separator and drops empty/dot segments', () => {
    expect(pathSegments('a/b/c')).toEqual(['a', 'b', 'c']);
    expect(pathSegments('a\\b\\c')).toEqual(['a', 'b', 'c']);
    expect(pathSegments('./a//b/')).toEqual(['a', 'b']);
    expect(pathSegments('')).toEqual([]);
  });
});

describe('firstMatchingPathRule', () => {
  test('returns the first rule that covers the path, or undefined', () => {
    const rules = [rule('*.lock'), rule('migrations/**')];
    expect(firstMatchingPathRule(rules, 'migrations/001.sql')?.pattern).toBe('migrations/**');
    expect(firstMatchingPathRule(rules, 'src/main.ts')).toBeUndefined();
  });

  test('an empty path matches nothing (the repo root is never a target)', () => {
    expect(firstMatchingPathRule([rule('**')], '')).toBeUndefined();
  });
});

describe('compileBashPattern', () => {
  test('compiles a valid regex', () => {
    const compiled = compileBashPattern('--no-verify');
    expect(compiled.error).toBeUndefined();
    expect(bashPatternMatches(compiled.regex!, 'git commit --no-verify -m x')).toBe(true);
  });

  test('reports an invalid regex instead of throwing', () => {
    const compiled = compileBashPattern('**/*.lock');
    expect(compiled.regex).toBeUndefined();
    expect(compiled.error).toBeTruthy();
  });

  test('reports an oversized pattern', () => {
    const compiled = compileBashPattern('a'.repeat(MAX_BASH_PATTERN_LENGTH + 1));
    expect(compiled.error).toContain(String(MAX_BASH_PATTERN_LENGTH));
  });

  test('matching is case-sensitive', () => {
    const compiled = compileBashPattern('--no-verify');
    expect(bashPatternMatches(compiled.regex!, 'git commit --NO-VERIFY')).toBe(false);
  });
});

describe('tool matchers', () => {
  test('exact names match, near-misses do not', () => {
    const matcher = compileToolEntries(['WebSearch', '  ', '']);
    expect(toolMatches(matcher, 'WebSearch')).toBe(true);
    expect(toolMatches(matcher, 'websearch')).toBe(false);
    expect(matcher.exact.size).toBe(1);
  });

  test('an mcp__server__* entry gates the whole server', () => {
    const matcher = compileToolEntries(['mcp__acme__*']);
    expect(isMcpGlobEntry('mcp__acme__*')).toBe(true);
    expect(toolMatches(matcher, 'mcp__acme__push')).toBe(true);
    expect(toolMatches(matcher, 'mcp__other__push')).toBe(false);
  });

  test('a trailing * on a native name is literal, never a wildcard', () => {
    const matcher = compileToolEntries(['Web*']);
    expect(toolMatches(matcher, 'WebSearch')).toBe(false);
    expect(toolMatches(matcher, 'Web*')).toBe(true);
  });
});
