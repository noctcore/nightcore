/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { whichSync } from './which.js';

describe('whichSync', () => {
  test('returns null for a binary that cannot exist on PATH', () => {
    // A name no real executable uses — the resolver exits non-zero and we swallow.
    expect(whichSync('nightcore-definitely-not-a-real-binary-xyz')).toBeNull();
  });

  test('resolves a present executable to an absolute path', () => {
    // The platform resolver itself (`which`/`where`) is always on PATH wherever
    // this test runs, so it is a stable fixture for the success branch.
    const resolverName = process.platform === 'win32' ? 'where' : 'which';
    const resolved = whichSync(resolverName);
    expect(resolved).not.toBeNull();
    expect(isAbsolute(resolved as string)).toBe(true);
  });

  test('returns the first line when the resolver prints multiple matches', () => {
    // `which`/`where` print one match per line; whichSync must take the first and
    // never include a trailing newline.
    const resolved = whichSync(process.platform === 'win32' ? 'where' : 'which');
    expect(resolved).not.toContain('\n');
    expect(resolved).toBe((resolved as string).trim());
  });
});
