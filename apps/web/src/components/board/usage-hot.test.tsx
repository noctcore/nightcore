import { expect, test } from 'vitest';

import type { RateWindow, UsageMeter } from '@/lib/bridge';

import { formatResetClock, hotUsageWindow, providerDisplay } from './usage-hot';

/** A claude row with the given status/stale/windows; codex dormant. Mirrors the Rust
 *  throttle fixtures so the web selector and the backend gate stay in lockstep. */
function meter(
  status: UsageMeter['providers'][number]['status'],
  stale: boolean,
  windows: RateWindow[],
): UsageMeter {
  return {
    providers: [
      { provider: 'claude', status, stale, windows },
      { provider: 'codex', status: 'notConnected', stale: false, windows: [] },
    ],
  };
}

const win = (kind: string, label: string, usedPercent: number, resetsAt?: string): RateWindow => ({
  kind,
  label,
  usedPercent,
  ...(resetsAt !== undefined ? { resetsAt } : {}),
});

const ok = (windows: RateWindow[]): UsageMeter => meter('ok', false, windows);

test('returns null for a null meter (never fetched)', () => {
  expect(hotUsageWindow(null, 90)).toBeNull();
});

test('a disabled / not-connected meter is cool (no chip, no banner)', () => {
  expect(hotUsageWindow(meter('disabled', false, []), 90)).toBeNull();
  expect(hotUsageWindow(meter('notConnected', false, []), 90)).toBeNull();
});

test('every non-ok status fails cool even with a window over threshold', () => {
  for (const status of ['stale', 'rateLimited', 'unauthorized', 'unsupported'] as const) {
    expect(hotUsageWindow(meter(status, false, [win('5h', 'Session (5h)', 99)]), 90)).toBeNull();
  }
});

test('an ok-but-stale row fails cool', () => {
  expect(hotUsageWindow(meter('ok', true, [win('5h', 'Session (5h)', 99)]), 90)).toBeNull();
});

test('all windows under threshold → cool', () => {
  expect(
    hotUsageWindow(ok([win('5h', 'Session (5h)', 40), win('weekly', 'Weekly', 89)]), 90),
  ).toBeNull();
});

test('a hot 5h window returns its specifics', () => {
  const hot = hotUsageWindow(ok([win('5h', 'Session (5h)', 93, '2026-07-11T18:00:00Z')]), 90);
  expect(hot).toEqual({
    provider: 'claude',
    windowLabel: 'Session (5h)',
    usedPercent: 93,
    resetsAt: '2026-07-11T18:00:00Z',
  });
});

test('a model-scoped window gates even when 5h and weekly are cool (ANY window)', () => {
  const hot = hotUsageWindow(
    ok([
      win('5h', 'Session (5h)', 20),
      win('weekly', 'Weekly', 55),
      win('weekly_opus', 'Opus weekly', 96),
    ]),
    90,
  );
  expect(hot?.windowLabel).toBe('Opus weekly');
  expect(hot?.usedPercent).toBe(96);
});

test('the hottest window wins for the copy; missing reset → null', () => {
  const hot = hotUsageWindow(
    ok([win('5h', 'Session (5h)', 91), win('weekly', 'Weekly', 97.5)]),
    90,
  );
  expect(hot?.windowLabel).toBe('Weekly');
  expect(hot?.resetsAt).toBeNull();
});

test('the threshold boundary is inclusive (>=)', () => {
  expect(hotUsageWindow(ok([win('5h', 'Session (5h)', 90)]), 90)).not.toBeNull();
});

test('providerDisplay capitalizes known ids, passes others through', () => {
  expect(providerDisplay('claude')).toBe('Claude');
  expect(providerDisplay('codex')).toBe('Codex');
  expect(providerDisplay('mystery')).toBe('mystery');
});

test('formatResetClock returns null for null / unparseable, a clock otherwise', () => {
  expect(formatResetClock(null)).toBeNull();
  expect(formatResetClock('not-a-date')).toBeNull();
  expect(formatResetClock('2026-07-11T18:00:00Z')).toMatch(/\d{1,2}:\d{2}/);
});
