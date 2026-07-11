import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { RateWindow, UsageCost, UsageMeter } from '@/lib/bridge';

import { compactWindows, windowSummary } from './UsageMeter.hooks';
import * as stories from './UsageMeter.stories';
import type { UsageSource } from './UsageMeter.types';

const { Disabled, NotConnected, Active, Stale, Unauthorized, Unsupported, Collapsed } =
  composeStories(stories);

const COST: UsageCost = {
  provider: 'claude',
  costUsd: 12.34,
  approximate: true,
  computedAt: '2026-07-11T00:00:00.000Z',
};

const future = (ms: number): string => new Date(Date.now() + ms).toISOString();

const CLAUDE_OK: UsageMeter = {
  providers: [
    {
      provider: 'claude',
      status: 'ok',
      stale: false,
      updatedAt: new Date().toISOString(),
      windows: [
        { kind: '5h', label: 'Session (5h)', usedPercent: 42, resetsAt: future(2 * 3_600_000) },
        { kind: 'weekly', label: 'Weekly', usedPercent: 68, resetsAt: future(3 * 86_400_000) },
      ],
    },
    { provider: 'codex', status: 'notConnected', stale: false, windows: [] },
  ],
};

const CLAUDE_REAUTH: UsageMeter = {
  providers: [
    {
      provider: 'claude',
      status: 'unauthorized',
      stale: false,
      windows: [],
      message: 'Session expired — run `claude` to re-sign-in.',
    },
    { provider: 'codex', status: 'notConnected', stale: false, windows: [] },
  ],
};

/** A spy data seam whose `subscribe` handler can be driven from the test to
 *  simulate a live `nc:usage` push. */
function makeSpySource(
  initial: UsageMeter,
  overrides: Partial<UsageSource> = {},
): { source: UsageSource; push: (meter: UsageMeter) => void } {
  let handler: ((meter: UsageMeter) => void) | null = null;
  const source: UsageSource = {
    getUsage: vi.fn(() => Promise.resolve(initial)),
    enable: vi.fn(() => Promise.resolve(initial)),
    refresh: vi.fn(() => Promise.resolve()),
    getCost: vi.fn(() => Promise.resolve(COST)),
    subscribe: vi.fn((h: (meter: UsageMeter) => void) => {
      handler = h;
      return Promise.resolve(() => {});
    }),
    ...overrides,
  };
  return { source, push: (meter) => handler?.(meter) };
}

test('renders the dormant Enable affordance when the meter is opt-in-off', async () => {
  const screen = render(<Disabled />);
  await expect
    .element(screen.getByRole('button', { name: 'Enable usage meter' }))
    .toBeVisible();
});

test('clicking Enable fires the opt-in gesture', async () => {
  // A disabled snapshot so the widget shows the Enable button.
  const disabled: UsageMeter = {
    providers: [
      { provider: 'claude', status: 'disabled', stale: false, windows: [] },
      { provider: 'codex', status: 'disabled', stale: false, windows: [] },
    ],
  };
  const { source } = makeSpySource(disabled);
  const screen = render(<Disabled source={source} />);
  await screen.getByRole('button', { name: 'Enable usage meter' }).click();
  expect(source.enable).toHaveBeenCalled();
});

test('renders a dormant not-connected row per provider', async () => {
  const screen = render(<NotConnected />);
  await expect.element(screen.getByText('Claude — not connected')).toBeInTheDocument();
  await expect.element(screen.getByText('Codex — not connected')).toBeInTheDocument();
});

test('renders session + weekly bars with a reset countdown when active', async () => {
  const screen = render(<Active />);
  await expect.element(screen.getByText('Session (5h)')).toBeInTheDocument();
  await expect.element(screen.getByText('Weekly')).toBeInTheDocument();
  await expect.element(screen.getByText(/resets in/).first()).toBeInTheDocument();
});

test('marks a stale provider with a status badge', async () => {
  const screen = render(<Stale />);
  await expect.element(screen.getByText('stale')).toBeInTheDocument();
});

test('shows the re-sign-in hint for an unauthorized provider', async () => {
  const screen = render(<Unauthorized />);
  await expect.element(screen.getByText(/to re-sign-in/)).toBeInTheDocument();
});

test('marks an unsupported provider as unavailable', async () => {
  const screen = render(<Unsupported />);
  await expect.element(screen.getByText('unavailable')).toBeInTheDocument();
});

test('opening a provider popover lazily fetches the local cost estimate', async () => {
  const { source } = makeSpySource(CLAUDE_OK);
  const screen = render(<Active source={source} />);
  await screen.getByRole('button', { name: /Claude/i }).click();
  await expect.element(screen.getByRole('dialog')).toBeInTheDocument();
  await expect.element(screen.getByText(/12.34/)).toBeInTheDocument();
  expect(source.getCost).toHaveBeenCalledWith('claude');
});

test('the popover lists every window including model-scoped lanes', async () => {
  const active: UsageMeter = {
    providers: [
      {
        provider: 'claude',
        status: 'ok',
        stale: false,
        windows: [
          { kind: '5h', label: 'Session (5h)', usedPercent: 42, resetsAt: future(2 * 3_600_000) },
          {
            kind: 'weekly_opus',
            label: 'Opus weekly',
            usedPercent: 91,
            resetsAt: future(3 * 86_400_000),
            scopeModel: 'Opus',
          },
        ],
      },
      { provider: 'codex', status: 'notConnected', stale: false, windows: [] },
    ],
  };
  const { source } = makeSpySource(active);
  const screen = render(<Active source={source} />);
  await screen.getByRole('button', { name: /Claude/i }).click();
  await expect.element(screen.getByText('Opus weekly')).toBeInTheDocument();
});

test('fetches on mount, updates on a live push, and refetches on window focus', async () => {
  const { source, push } = makeSpySource(CLAUDE_OK);
  const screen = render(<Active source={source} />);

  // Mount fetch.
  await expect.element(screen.getByText('Session (5h)')).toBeInTheDocument();
  expect(source.getUsage).toHaveBeenCalled();

  // A live `nc:usage` push swaps the snapshot (claude → unauthorized).
  push(CLAUDE_REAUTH);
  await expect.element(screen.getByText(/to re-sign-in/)).toBeInTheDocument();

  // A window focus kicks a staleness-guarded refresh.
  window.dispatchEvent(new Event('focus'));
  expect(source.refresh).toHaveBeenCalled();
});

test('the collapsed rail renders icon-only, not labeled bars', async () => {
  const screen = render(<Collapsed />);
  // The provider dot is a button whose accessible name is the compact summary…
  await expect.element(screen.getByRole('button', { name: /Claude/i })).toBeVisible();
  // …but the labeled bars only appear expanded.
  expect(screen.getByText('Session (5h)').query()).toBeNull();
});

test('the collapsed rail shows an immediate hover tooltip summarizing the windows', async () => {
  // Issue #121: hovering a collapsed provider icon must show the usage numbers
  // ("Claude — 5h 42% · weekly 68%") via the group-hover tooltip, not the slow
  // native `title`. The Collapsed story's Claude row carries 5h 42% + weekly 68%.
  const screen = render(<Collapsed />);
  const button = screen.getByRole('button', { name: /Claude — 5h 42% · weekly 68%/ });
  await expect.element(button).toBeVisible();
  // The tooltip text is present in the DOM (revealed on hover via opacity).
  await expect.element(screen.getByText('Claude — 5h 42% · weekly 68%')).toBeInTheDocument();
});

// ── Pure selectors (issue #121) ────────────────────────────────────────────────
const win = (kind: string, usedPercent: number, label = kind): RateWindow => ({
  kind,
  label,
  usedPercent,
});

test('compactWindows picks the 5h + weekly lanes even amid model-scoped weeklies', () => {
  // The dogfood shape: a 5h, the primary weekly, and TWO model-scoped weeklies. The
  // compact row must be exactly [5h, weekly] — the model-scoped lanes never crowd
  // out the session lane (they live only in the detail popover).
  const windows: RateWindow[] = [
    win('weekly_opus', 91, 'Opus weekly'),
    win('5h', 12, 'Session (5h)'),
    win('weekly', 72, 'Weekly'),
    win('weekly_sonnet', 30, 'Sonnet weekly'),
  ];
  const compact = compactWindows(windows);
  expect(compact.map((w) => w.kind)).toEqual(['5h', 'weekly']);
});

test('compactWindows keeps the 5h lane first even when weekly is absent', () => {
  expect(compactWindows([win('5h', 20)]).map((w) => w.kind)).toEqual(['5h']);
  // With only a weekly (the pre-fix Claude bug), it still renders — just the weekly.
  expect(compactWindows([win('weekly', 72)]).map((w) => w.kind)).toEqual(['weekly']);
});

test('compactWindows falls back to the first two windows when no canonical lane exists', () => {
  const windows: RateWindow[] = [win('model:a', 10), win('model:b', 20), win('model:c', 30)];
  expect(compactWindows(windows).map((w) => w.kind)).toEqual(['model:a', 'model:b']);
});

test('windowSummary renders a "5h % · weekly %" one-liner for the collapsed tooltip', () => {
  const windows: RateWindow[] = [
    win('5h', 12.4, 'Session (5h)'),
    win('weekly', 71.6, 'Weekly'),
    win('weekly_opus', 91, 'Opus weekly'),
  ];
  expect(windowSummary(windows)).toBe('5h 12% · weekly 72%');
  expect(windowSummary([])).toBe('');
});
