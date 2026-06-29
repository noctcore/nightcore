import { expect, test } from 'vitest';

import { formatLocation } from './formatters';

test('returns null for a missing location', () => {
  expect(formatLocation(null)).toBeNull();
});

test('renders just the file when no start line is known', () => {
  expect(
    formatLocation({ file: 'a/b.ts', startLine: null, endLine: null, symbol: null }),
  ).toBe('a/b.ts');
});

test('renders file:line for a single line', () => {
  expect(
    formatLocation({ file: 'a/b.ts', startLine: 12, endLine: null, symbol: null }),
  ).toBe('a/b.ts:12');
});

test('renders a line range when start and end differ', () => {
  expect(
    formatLocation({ file: 'a/b.ts', startLine: 3, endLine: 9, symbol: null }),
  ).toBe('a/b.ts:3-9');
});

test('collapses a range whose end equals its start', () => {
  expect(
    formatLocation({ file: 'a/b.ts', startLine: 5, endLine: 5, symbol: null }),
  ).toBe('a/b.ts:5');
});

test('omits the symbol by default and appends it with withSymbol', () => {
  const loc = { file: 'a/b.ts', startLine: 5, endLine: null, symbol: 'doThing' };
  expect(formatLocation(loc)).toBe('a/b.ts:5');
  expect(formatLocation(loc, { withSymbol: true })).toBe('a/b.ts:5 · doThing');
});

test('does not append a symbol on a file-only (no line) location', () => {
  expect(
    formatLocation(
      { file: 'a/b.ts', startLine: null, endLine: null, symbol: 'x' },
      { withSymbol: true },
    ),
  ).toBe('a/b.ts');
});
