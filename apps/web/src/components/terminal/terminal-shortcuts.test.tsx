import { describe, expect, test } from 'vitest';

import { nthSessionId } from './terminal-shortcuts';

describe('nthSessionId (⌘1..9, #405)', () => {
  const ids = ['a', 'b', 'c', 'd'];

  test('1..n select by DISPLAY position, so the number matches what the user sees', () => {
    expect(nthSessionId(ids, 1)).toBe('a');
    expect(nthSessionId(ids, 2)).toBe('b');
    expect(nthSessionId(ids, 3)).toBe('c');
  });

  test('9 means the LAST session, not literally the ninth', () => {
    // The field's convention (VS Code / iTerm2 / Chrome). It also makes a tail tab
    // reachable at all: the session cap is 12, so slots 10-12 have no digit of their own.
    expect(nthSessionId(ids, 9)).toBe('d');
    expect(nthSessionId(['only'], 9)).toBe('only');
    const twelve = Array.from({ length: 12 }, (_, i) => `s${i}`);
    expect(nthSessionId(twelve, 9)).toBe('s11');
    expect(nthSessionId(twelve, 8)).toBe('s7');
  });

  test('an empty slot is null rather than a wrong tab', () => {
    expect(nthSessionId(ids, 5)).toBeNull();
    expect(nthSessionId([], 1)).toBeNull();
  });

  test('out-of-range digits are refused', () => {
    expect(nthSessionId(ids, 0)).toBeNull();
    expect(nthSessionId(ids, 10)).toBeNull();
    expect(nthSessionId(ids, -1)).toBeNull();
  });
});
