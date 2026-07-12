import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { UsageMeter } from '@/lib/bridge';

import type { UsageMeterEnabledState } from './useUsageMeterEnabled';
import { isMeterEnabled, useUsageMeterEnabled } from './useUsageMeterEnabled';

const enableMock = vi.fn<() => Promise<UsageMeter>>();
const disableMock = vi.fn<() => Promise<void>>();
let push: ((meter: UsageMeter) => void) | null = null;
let unsubCalls = 0;

vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    enableUsageMeter: () => enableMock(),
    disableUsageMeter: () => disableMock(),
    onUsageEvent: (handler: (meter: UsageMeter) => void) => {
      push = handler;
      return Promise.resolve(() => {
        unsubCalls += 1;
        push = null;
      });
    },
  };
});

const ENABLED_METER: UsageMeter = {
  providers: [
    { provider: 'claude', status: 'notConnected', stale: false, windows: [] },
    { provider: 'codex', status: 'notConnected', stale: false, windows: [] },
  ],
};

const DISABLED_METER: UsageMeter = {
  providers: [
    { provider: 'claude', status: 'disabled', stale: false, windows: [] },
    { provider: 'codex', status: 'disabled', stale: false, windows: [] },
  ],
};

/** Simulate a live `nc:usage` push. A dedicated function (rather than calling
 *  `push?.(meter)` inline in each test) so TS narrows `push` fresh on every call —
 *  inline, a test's own `push = null;` reset narrows the module-level `let` to
 *  `null` for the rest of that scope, since TS's control-flow analysis doesn't
 *  know the intervening `render()` reassigns it via the mocked subscription. */
function emit(meter: UsageMeter): void {
  push?.(meter);
}

/** A harness that renders the visible state as text AND hands the test the live
 *  `{ enabled, enable, disable }` via `capture`, so tests can drive `enable()` /
 *  `disable()` directly (with their own `.catch`) instead of routing through a DOM
 *  click and risking an unhandled rejection on the failure-path tests. */
function Harness({
  seed,
  capture,
}: {
  seed: boolean;
  capture: (state: UsageMeterEnabledState) => void;
}) {
  const state = useUsageMeterEnabled(seed);
  capture(state);
  return <span>{state.enabled ? 'Enabled' : 'Disabled'}</span>;
}

function mountHarness(seed: boolean) {
  let latest!: UsageMeterEnabledState;
  const screen = render(<Harness seed={seed} capture={(state) => (latest = state)} />);
  return { screen, current: () => latest };
}

test('isMeterEnabled is false only when every provider row is disabled', () => {
  expect(isMeterEnabled(DISABLED_METER)).toBe(false);
  expect(isMeterEnabled(ENABLED_METER)).toBe(true);
});

test('seeds from the settings value on mount', async () => {
  push = null;
  const on = mountHarness(true);
  await expect.element(on.screen.getByText('Enabled')).toBeInTheDocument();

  const off = mountHarness(false);
  await expect.element(off.screen.getByText('Disabled')).toBeInTheDocument();
});

test('flips off when a disabled nc:usage snapshot arrives live', async () => {
  push = null;
  const { screen } = mountHarness(true);
  await expect.element(screen.getByText('Enabled')).toBeInTheDocument();

  // A live push — e.g. Settings disabled the meter, or the poller re-emitted after
  // a race — reconciles this consumer without any local action.
  emit(DISABLED_METER);
  await expect.element(screen.getByText('Disabled')).toBeInTheDocument();
});

test('flips on when a live push reports an enabled snapshot (e.g. a sidebar enable)', async () => {
  push = null;
  const { screen } = mountHarness(false);
  await expect.element(screen.getByText('Disabled')).toBeInTheDocument();

  // The sidebar widget's own "Enable" gesture calls the SAME `enable_usage_meter`
  // command, which now pushes its snapshot on this channel — this consumer must
  // reconcile from that push alone, without calling `enable()` itself.
  emit(ENABLED_METER);
  await expect.element(screen.getByText('Enabled')).toBeInTheDocument();
});

test('enable() calls the bridge command and flips enabled once it resolves', async () => {
  push = null;
  enableMock.mockReset().mockResolvedValue(ENABLED_METER);
  const { screen, current } = mountHarness(false);
  await expect.element(screen.getByText('Disabled')).toBeInTheDocument();

  await current().enable();
  expect(enableMock).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByText('Enabled')).toBeInTheDocument();
});

test('disable() calls the bridge command and flips enabled once it resolves', async () => {
  push = null;
  disableMock.mockReset().mockResolvedValue(undefined);
  const { screen, current } = mountHarness(true);
  await expect.element(screen.getByText('Enabled')).toBeInTheDocument();

  await current().disable();
  expect(disableMock).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByText('Disabled')).toBeInTheDocument();
});

test('a failed enable() rejects without optimistically flipping enabled', async () => {
  push = null;
  enableMock.mockReset().mockRejectedValue(new Error('denied'));
  const { screen, current } = mountHarness(false);
  await expect.element(screen.getByText('Disabled')).toBeInTheDocument();

  await expect(current().enable()).rejects.toThrow('denied');
  await expect.element(screen.getByText('Disabled')).toBeInTheDocument();
});

test('unsubscribes the nc:usage listener on unmount', async () => {
  push = null;
  unsubCalls = 0;
  const { screen } = mountHarness(true);
  await expect.element(screen.getByText('Enabled')).toBeInTheDocument();
  expect(push).not.toBeNull();
  screen.unmount();
  expect(unsubCalls).toBe(1);
});
