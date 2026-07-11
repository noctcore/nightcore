import { expect, test } from 'vitest';

import { formatCountdown, formatLocation } from './formatters';

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

const T0 = Date.parse('2026-07-11T00:00:00.000Z');

test('formatCountdown shows hours and minutes for a multi-hour window', () => {
  expect(formatCountdown('2026-07-11T02:15:00.000Z', T0)).toBe('2h 15m');
});

test('formatCountdown drops the minutes when a window resets on the hour', () => {
  expect(formatCountdown('2026-07-11T03:00:00.000Z', T0)).toBe('3h');
});

test('formatCountdown shows days and hours for a weekly window', () => {
  expect(formatCountdown('2026-07-13T06:00:00.000Z', T0)).toBe('2d 6h');
});

test('formatCountdown shows just minutes under an hour', () => {
  expect(formatCountdown('2026-07-11T00:42:00.000Z', T0)).toBe('42m');
});

test('formatCountdown collapses a sub-minute remainder to <1m', () => {
  expect(formatCountdown('2026-07-11T00:00:30.000Z', T0)).toBe('<1m');
});

test('formatCountdown reports now once the instant has elapsed', () => {
  expect(formatCountdown('2026-07-10T23:00:00.000Z', T0)).toBe('now');
});

test('formatCountdown returns an empty string for an unparseable value', () => {
  expect(formatCountdown('not-a-date', T0)).toBe('');
});
