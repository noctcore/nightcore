/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { initialView } from '../session-reducer.js';
import type { SessionView } from '../types.js';
import { buildPalette, matchPalette } from './palette.js';

function viewWith(slashCommands: string[]): SessionView {
  return { ...initialView('m', 'plan', null), slashCommands };
}

describe('buildPalette', () => {
  test('local commands first, then non-shadowed SDK commands', () => {
    const palette = buildPalette(viewWith(['compact', 'help']));
    const local = palette.filter((e) => e.source === 'local').map((e) => e.name);
    const sdk = palette.filter((e) => e.source === 'sdk').map((e) => e.name);

    expect(local).toContain('help');
    expect(local).toContain('model');
    // `help` is shadowed by the local command, so it is dropped from the SDK set.
    expect(sdk).toEqual(['compact']);
  });
});

describe('matchPalette', () => {
  test('filters by typed prefix, case-insensitively', () => {
    const matches = matchPalette(viewWith([]), 'mo');
    expect(matches.map((e) => e.name)).toEqual(['model']);
  });

  test('empty prefix returns the whole palette', () => {
    const all = matchPalette(viewWith(['compact']), '');
    expect(all.length).toBe(buildPalette(viewWith(['compact'])).length);
  });

  test('SDK commands match too', () => {
    const matches = matchPalette(viewWith(['compact', 'cost']), 'co');
    expect(matches.map((e) => e.name).sort()).toEqual(['compact', 'cost']);
  });
});
