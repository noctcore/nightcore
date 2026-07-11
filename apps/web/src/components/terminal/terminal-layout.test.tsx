import { afterEach, describe, expect, test } from 'vitest';

import type { TerminalSessionInfo } from '@/lib/bridge';

import {
  orderSessions,
  readLayout,
  reorderByDrop,
  TERMINAL_LAYOUT_KEY,
  writeLayout,
} from './terminal-layout';

// The layout blob is a web-side localStorage preference; clean it between tests so
// one test's persisted order/mode never leaks into another (the shared browser
// context keeps localStorage across test files).
afterEach(() => {
  window.localStorage.removeItem(TERMINAL_LAYOUT_KEY);
});

function session(id: string): TerminalSessionInfo {
  return {
    id,
    cwd: `/tmp/${id}`,
    shell: '/bin/zsh',
    confined: false,
    cols: 80,
    rows: 24,
    alive: true,
    createdAt: 0,
    title: null,
    titleSource: null,
  };
}

describe('readLayout / writeLayout', () => {
  test('defaults to tabs + empty order when nothing is persisted', () => {
    expect(readLayout()).toEqual({ mode: 'tabs', order: [] });
  });

  test('round-trips the persisted view mode + pane order', () => {
    writeLayout({ mode: 'grid', order: ['a', 'b', 'c'] });
    expect(readLayout()).toEqual({ mode: 'grid', order: ['a', 'b', 'c'] });
  });

  test('tolerates a corrupt / non-object / partial blob, falling back to defaults', () => {
    window.localStorage.setItem(TERMINAL_LAYOUT_KEY, 'not json{');
    expect(readLayout()).toEqual({ mode: 'tabs', order: [] });

    window.localStorage.setItem(TERMINAL_LAYOUT_KEY, JSON.stringify({ mode: 'weird' }));
    // Unknown mode falls back to tabs; missing order → empty.
    expect(readLayout()).toEqual({ mode: 'tabs', order: [] });

    window.localStorage.setItem(
      TERMINAL_LAYOUT_KEY,
      JSON.stringify({ mode: 'grid', order: ['ok', 3, null, 'two'] }),
    );
    // Non-string ids are filtered out.
    expect(readLayout()).toEqual({ mode: 'grid', order: ['ok', 'two'] });
  });
});

describe('orderSessions', () => {
  test('applies the persisted order, appends unknown (new) sessions at the end', () => {
    const sessions = [session('a'), session('b'), session('c')];
    // `c` is persisted first, `a` second; `b` is new → appended after the knowns.
    const ordered = orderSessions(sessions, ['c', 'a']);
    expect(ordered.map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  test('drops persisted ids whose session is gone (a closed shell)', () => {
    const sessions = [session('a'), session('b')];
    const ordered = orderSessions(sessions, ['gone', 'b', 'also-gone', 'a']);
    expect(ordered.map((s) => s.id)).toEqual(['b', 'a']);
  });

  test('is stable for an empty order (arrival order preserved)', () => {
    const sessions = [session('a'), session('b')];
    expect(orderSessions(sessions, []).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('reorderByDrop', () => {
  test('moves the active id into the over id slot (forward)', () => {
    expect(reorderByDrop(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  test('moves the active id into the over id slot (backward)', () => {
    expect(reorderByDrop(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  test('is a no-op copy when the ids match or either is absent', () => {
    expect(reorderByDrop(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
    expect(reorderByDrop(['a', 'b'], 'x', 'b')).toEqual(['a', 'b']);
    expect(reorderByDrop(['a', 'b'], 'a', 'y')).toEqual(['a', 'b']);
  });
});
