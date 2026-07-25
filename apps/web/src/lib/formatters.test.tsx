import { expect, test } from 'vitest';

import {
  formatCountdown,
  formatDurationMs,
  formatLocation,
  formatRelativeTimeAgo,
  formatTokensCompact,
  pluralize,
} from './formatters';

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

test('formatTokensCompact keeps small counts exact and compacts larger ones', () => {
  expect(formatTokensCompact(0)).toBe('0');
  expect(formatTokensCompact(842)).toBe('842');
  expect(formatTokensCompact(1240)).toBe('1.2k');
  expect(formatTokensCompact(34_000)).toBe('34k');
  expect(formatTokensCompact(2_100_000)).toBe('2.1M');
});

test('formatTokensCompact clamps a negative/absent count to zero', () => {
  expect(formatTokensCompact(-5)).toBe('0');
});

test('formatDurationMs renders compact two-unit spans', () => {
  expect(formatDurationMs(0)).toBe('0s');
  expect(formatDurationMs(12_000)).toBe('12s');
  expect(formatDurationMs(65_000)).toBe('1m 5s');
  expect(formatDurationMs(60_000)).toBe('1m');
  expect(formatDurationMs(3_600_000)).toBe('1h');
  expect(formatDurationMs(7_380_000)).toBe('2h 3m');
});

test('formatDurationMs clamps a negative or NaN duration to 0s', () => {
  expect(formatDurationMs(-1)).toBe('0s');
  expect(formatDurationMs(Number.NaN)).toBe('0s');
});

test('pluralize keeps the singular for one and adds -s otherwise', () => {
  expect(pluralize(1, 'task')).toBe('1 task');
  expect(pluralize(0, 'task')).toBe('0 tasks');
  expect(pluralize(3, 'file')).toBe('3 files');
});

test('pluralize honors an explicit irregular plural', () => {
  expect(pluralize(1, 'entry', 'entries')).toBe('1 entry');
  expect(pluralize(2, 'entry', 'entries')).toBe('2 entries');
});

test('formatRelativeTimeAgo suffixes "ago" but leaves "just now" alone', () => {
  const now = 1_700_000_000_000;
  expect(formatRelativeTimeAgo(now, now)).toBe('just now');
  expect(formatRelativeTimeAgo(now - 5 * 60_000, now)).toBe('5m ago');
  expect(formatRelativeTimeAgo('not-a-date', now)).toBe('');
});
