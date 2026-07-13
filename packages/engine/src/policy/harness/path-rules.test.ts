/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { compilePathRule, ruleProtects } from './path-rules.js';

/** Compile `pattern` and report whether it protects `relPath` (repo-relative,
 *  `/`-separated). Mirrors how `harness-policy.ts`'s `matchPathRules` splits a
 *  resolved, cwd-relative path into segments before calling `ruleProtects`. */
function protects(pattern: string, relPath: string): boolean {
  const rule = compilePathRule(pattern);
  if (rule === undefined) return false;
  const segments = relPath.split('/').filter((s) => s.length > 0);
  return ruleProtects(rule, segments);
}

describe('compilePathRule — degenerate patterns', () => {
  test('empty / whitespace-only / bare-separator patterns are unusable', () => {
    expect(compilePathRule('')).toBeUndefined();
    expect(compilePathRule('   ')).toBeUndefined();
    expect(compilePathRule('/')).toBeUndefined();
  });

  test('author sugar is tolerated: leading ./ or / and a trailing /', () => {
    expect(compilePathRule('./migrations/')).toBeDefined();
    expect(compilePathRule('/src/generated/')).toBeDefined();
    expect(protects('./migrations/', 'migrations/001.sql')).toBe(true);
    expect(protects('/src/generated/', 'src/generated/api.ts')).toBe(true);
  });
});

describe('anchored patterns (contain a "/")', () => {
  test('a glob pattern blocks a matching path and allows a non-match', () => {
    expect(protects('migrations/**', 'migrations/001_init.sql')).toBe(true);
    expect(protects('migrations/**', 'src/app.ts')).toBe(false);
  });

  test('a non-glob anchored pattern protects its whole subtree', () => {
    expect(protects('src/generated', 'src/generated/api.ts')).toBe(true);
    expect(protects('src/generated', 'src/generated')).toBe(true);
    expect(protects('src/generated', 'src/generate/api.ts')).toBe(false);
    // `src/generated-extra` must not match `src/generated` (segment, not prefix).
    expect(protects('src/generated', 'src/generated-extra/api.ts')).toBe(false);
  });

  test('`**` in the middle of a pattern spans zero or more segments', () => {
    expect(protects('packages/**/generated/**', 'packages/a/b/generated/x.ts')).toBe(
      true,
    );
    expect(protects('packages/**/generated/**', 'packages/a/generated/x.ts')).toBe(true);
    expect(protects('packages/**/generated/**', 'packages/a/src/x.ts')).toBe(false);
  });

  test('`*` matches within a segment only, not across "/"', () => {
    expect(protects('db/*.sql', 'db/001.sql')).toBe(true);
    expect(protects('db/*.sql', 'db/deep/001.sql')).toBe(false);
  });

  test('regex metacharacters in a path pattern are literal', () => {
    expect(protects('file.(x)+?.ts', 'file.(x)+?.ts')).toBe(true);
    expect(protects('file.(x)+?.ts', 'fileA(x)Bts')).toBe(false);
  });
});

describe('floating patterns (no "/")', () => {
  test('a bare filename pattern matches at any depth', () => {
    expect(protects('bun.lock', 'bun.lock')).toBe(true);
    expect(protects('bun.lock', 'packages/web/bun.lock')).toBe(true);
    expect(protects('bun.lock', 'src/app.ts')).toBe(false);
  });

  test('a floating glob matches at any depth (gitignore-style)', () => {
    expect(protects('*.sql', 'db/001.sql')).toBe(true);
    expect(protects('*.lock', 'deep/nested/Cargo.lock')).toBe(true);
    expect(protects('*.lock', 'deep/nested/cargo.toml')).toBe(false);
  });

  test('matching is case-insensitive (case-variant paths cannot slip through)', () => {
    expect(protects('bun.lock', 'BUN.LOCK')).toBe(true);
  });
});
