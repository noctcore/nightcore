import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { Settings, SettingsPatch, UsageMeter } from '@/lib/bridge';
import { useUsageMeterEnabled } from '@/lib/useUsageMeterEnabled';

import { buildUsageCards } from './settings-usage-cards';
import { SettingsCard } from './SettingsCard';

const enableMock = vi.fn<() => Promise<UsageMeter>>();
const disableMock = vi.fn<() => Promise<void>>();
let push: ((meter: UsageMeter) => void) | null = null;

vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    enableUsageMeter: () => enableMock(),
    disableUsageMeter: () => disableMock(),
    onUsageEvent: (handler: (meter: UsageMeter) => void) => {
      push = handler;
      return Promise.resolve(() => {
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

const SETTINGS: Settings = {
  defaultModel: 'claude-opus-4-8',
  defaultEffort: 'high',
  maxConcurrency: 3,
  permissionMode: 'auto-accept',
  provider: 'claude',
  cleanupWorktrees: true,
  notifyOnComplete: false,
  notifyOnAwaitingInput: true,
  defaultRunMode: 'main',
  maxTurns: null,
  maxBudgetUsd: null,
  mcpServers: [],
  contextPackEnabled: true,
  planGateDefault: true,
  autoCommitOnVerified: false,
  sandboxSessions: false,
  issueSyncEnabled: false,
  sidebarStyle: 'unified',
  preferredEditor: null,
  terminalWebglEnabled: false,
  terminalConfinedDefault: false,
  terminalFontSize: null,
  terminalScrollback: null,
  usageMeterEnabled: false,
  autoPauseUsageThreshold: 90,
  terminalYoloLaunch: false,
  terminalDaemonEnabled: false,
  terminalAiNaming: false,
  terminalBellNotify: true,
  projectOverrides: {},
};

/** Mirrors how `SettingsView` composes the shared signal + the card builder: the
 *  hook seeded from settings, its state fed into `buildUsageCards`, rendered
 *  through the real `SettingsCard`. */
function Harness({
  settings = SETTINGS,
  patchGlobal = vi.fn(),
}: {
  settings?: Settings;
  patchGlobal?: (patch: SettingsPatch) => void;
}) {
  const usageMeter = useUsageMeterEnabled(settings.usageMeterEnabled);
  const [card] = buildUsageCards(settings, patchGlobal, usageMeter);
  return <SettingsCard {...card!} />;
}

test('the toggle reflects settings.usageMeterEnabled on mount', async () => {
  push = null;
  const screen = render(<Harness settings={{ ...SETTINGS, usageMeterEnabled: true }} />);
  await expect
    .element(screen.getByRole('switch', { name: 'Enable provider usage meter' }))
    .toHaveAttribute('aria-checked', 'true');
});

test('clicking the toggle enables the meter and mirrors the flag into settings', async () => {
  push = null;
  enableMock.mockReset().mockResolvedValue(ENABLED_METER);
  const patchGlobal = vi.fn();
  const screen = render(<Harness patchGlobal={patchGlobal} />);
  const toggle = screen.getByRole('switch', { name: 'Enable provider usage meter' });
  await expect.element(toggle).toHaveAttribute('aria-checked', 'false');

  await toggle.click();
  expect(enableMock).toHaveBeenCalledTimes(1);
  await expect.element(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => patchGlobal).toHaveBeenCalledWith({ usageMeterEnabled: true });
});

test('clicking the toggle disables the meter and mirrors the flag into settings', async () => {
  push = null;
  disableMock.mockReset().mockResolvedValue(undefined);
  const patchGlobal = vi.fn();
  const screen = render(
    <Harness settings={{ ...SETTINGS, usageMeterEnabled: true }} patchGlobal={patchGlobal} />,
  );
  const toggle = screen.getByRole('switch', { name: 'Enable provider usage meter' });
  await expect.element(toggle).toHaveAttribute('aria-checked', 'true');

  await toggle.click();
  expect(disableMock).toHaveBeenCalledTimes(1);
  await expect.element(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => patchGlobal).toHaveBeenCalledWith({ usageMeterEnabled: false });
});

test('a live nc:usage push reconciles the toggle without a click (e.g. sidebar enabled it)', async () => {
  push = null;
  const screen = render(<Harness />);
  const toggle = screen.getByRole('switch', { name: 'Enable provider usage meter' });
  await expect.element(toggle).toHaveAttribute('aria-checked', 'false');

  emit(ENABLED_METER);
  await expect.element(toggle).toHaveAttribute('aria-checked', 'true');

  emit(DISABLED_METER);
  await expect.element(toggle).toHaveAttribute('aria-checked', 'false');
});

test('the pause-threshold hint follows the live toggle state, not the stale settings snapshot', async () => {
  push = null;
  const screen = render(<Harness />);
  await expect
    .element(screen.getByText('Enable the usage meter above to use this.'))
    .toBeInTheDocument();

  // Settings never re-renders with a fresh `settings` prop here — only the live
  // `nc:usage` push changes anything, proving the hint reads the shared signal.
  emit(ENABLED_METER);
  await expect
    .element(screen.getByText(/Auto Mode stops picking up new runs/))
    .toBeInTheDocument();
});
