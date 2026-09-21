/// <reference types="bun" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createCtx } from './ctx.ts';

// A REAL tree on disk: a fake ctx would pass whatever the glob engine does.
let root = '';

function touch(rel: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, 'x\n');
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'nc-lint-meta-ctx-'));
  touch('.github/workflows/ci.yml');
  touch('.github/workflows/release.yml');
  touch('src/a.ts');
  touch('src/nested/b.ts');
  touch('src/.hidden/h.ts');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createCtx glob on a real tree', () => {
  test('sees files under a dot-directory named in the pattern', () => {
    const ctx = createCtx(root);
    expect(ctx.glob('.github/workflows/*.yml')).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
    ]);
    expect(ctx.glob('.github/workflows/ci.yml')).toEqual(['.github/workflows/ci.yml']);
    expect(ctx.glob('src/.hidden/*.ts')).toEqual(['src/.hidden/h.ts']);
  });

  test('a wildcard still never enters a dot-directory', () => {
    const ctx = createCtx(root);
    expect(ctx.glob('**/*.yml')).toEqual([]);
    expect(ctx.glob('src/**/*.ts')).toEqual(['src/a.ts', 'src/nested/b.ts']);
  });

  test('unsupported syntax throws instead of matching nothing', () => {
    const ctx = createCtx(root);
    expect(() => ctx.glob('src/+(a|b).ts')).toThrow(/not supported/);
  });

  test('read and exists resolve against the root', () => {
    const ctx = createCtx(root);
    expect(ctx.read('.github/workflows/ci.yml')).toBe('x\n');
    expect(ctx.read('missing.txt')).toBe(null);
    expect(ctx.exists('src/a.ts')).toBe(true);
  });
});
