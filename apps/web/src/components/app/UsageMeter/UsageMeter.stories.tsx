import type { Meta, StoryObj } from '@storybook/react-vite';

import type { UsageCost, UsageMeter } from '@/lib/bridge';

import { UsageMeter as UsageMeterWidget } from './UsageMeter';
import type { UsageSource } from './UsageMeter.types';

/** A future ISO instant `ms` from now — keeps reset countdowns stable across runs. */
const future = (ms: number): string => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CLAUDE_WINDOWS = [
  { kind: '5h', label: 'Session (5h)', usedPercent: 42, resetsAt: future(2 * HOUR + 15 * 60_000) },
  { kind: 'weekly', label: 'Weekly', usedPercent: 68, resetsAt: future(3 * DAY) },
  {
    kind: 'weekly_opus',
    label: 'Opus weekly',
    usedPercent: 91,
    resetsAt: future(3 * DAY),
    scopeModel: 'Opus',
  },
];

/** claude with live windows + credits; codex a dormant not-connected row. */
const ACTIVE_METER: UsageMeter = {
  updatedAt: new Date().toISOString(),
  providers: [
    {
      provider: 'claude',
      status: 'ok',
      stale: false,
      updatedAt: new Date().toISOString(),
      windows: CLAUDE_WINDOWS,
      credits: { hasCredits: true, balance: 12.5, currency: 'USD' },
    },
    { provider: 'codex', status: 'notConnected', stale: false, windows: [] },
  ],
};

const meterWith = (claude: UsageMeter['providers'][number]): UsageMeter => ({
  updatedAt: new Date().toISOString(),
  providers: [claude, { provider: 'codex', status: 'notConnected', stale: false, windows: [] }],
});

const DISABLED_METER: UsageMeter = {
  providers: [
    { provider: 'claude', status: 'disabled', stale: false, windows: [] },
    { provider: 'codex', status: 'disabled', stale: false, windows: [] },
  ],
};

const NOT_CONNECTED_METER: UsageMeter = {
  providers: [
    { provider: 'claude', status: 'notConnected', stale: false, windows: [] },
    { provider: 'codex', status: 'notConnected', stale: false, windows: [] },
  ],
};

const STALE_METER = meterWith({
  provider: 'claude',
  status: 'stale',
  stale: true,
  updatedAt: future(-14 * 60_000),
  windows: CLAUDE_WINDOWS,
});

const RATE_LIMITED_METER = meterWith({
  provider: 'claude',
  status: 'rateLimited',
  stale: true,
  updatedAt: future(-3 * 60_000),
  windows: CLAUDE_WINDOWS,
  message: 'Rate-limited — retrying shortly.',
});

const UNAUTHORIZED_METER = meterWith({
  provider: 'claude',
  status: 'unauthorized',
  stale: false,
  windows: [],
  message: 'Session expired — run `claude` to re-sign-in.',
});

const UNSUPPORTED_METER = meterWith({
  provider: 'claude',
  status: 'unsupported',
  stale: false,
  windows: [],
  message: 'This CLI token lacks the usage scope.',
});

const COST: UsageCost = {
  provider: 'claude',
  costUsd: 12.34,
  approximate: true,
  computedAt: new Date().toISOString(),
};

/** An in-memory data seam so every status renders without Tauri. */
function fixtureSource(meter: UsageMeter): UsageSource {
  return {
    getUsage: () => Promise.resolve(meter),
    enable: () => Promise.resolve(meter),
    refresh: () => Promise.resolve(),
    getCost: () => Promise.resolve(COST),
    subscribe: () => Promise.resolve(() => {}),
  };
}

const meta = {
  title: 'App/UsageMeter',
  component: UsageMeterWidget,
  args: { collapsed: false, source: fixtureSource(ACTIVE_METER) },
  decorators: [
    (Story) => (
      <div className="w-[244px] bg-sidebar pt-32">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UsageMeterWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Opt-in-off: the single dormant "Enable usage meter" affordance (decision 5). */
export const Disabled: Story = { args: { source: fixtureSource(DISABLED_METER) } };

/** Enabled but no credentials on disk — two dormant "not connected" rows. */
export const NotConnected: Story = { args: { source: fixtureSource(NOT_CONNECTED_METER) } };

/** Live windows: session + weekly bars with reset countdowns. */
export const Active: Story = {};

/** Transient failure — showing last-good windows, dimmed. */
export const Stale: Story = { args: { source: fixtureSource(STALE_METER) } };

/** In a 429 cooldown — last-good windows, dimmed. */
export const RateLimited: Story = { args: { source: fixtureSource(RATE_LIMITED_METER) } };

/** 401 / expired token — the re-sign-in hint (no self-refresh, decision 4). */
export const Unauthorized: Story = { args: { source: fixtureSource(UNAUTHORIZED_METER) } };

/** An unmodeled 4xx/5xx or scope gap — dim, with a status hint. */
export const Unsupported: Story = { args: { source: fixtureSource(UNSUPPORTED_METER) } };

/** The collapsed 66-px rail — icon-only per-provider dots. */
export const Collapsed: Story = {
  args: { collapsed: true },
  decorators: [
    (Story) => (
      <div className="w-[66px] bg-sidebar pt-32">
        <Story />
      </div>
    ),
  ],
};
