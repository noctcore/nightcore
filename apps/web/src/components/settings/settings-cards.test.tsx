import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { ProviderCapabilities } from '@nightcore/contracts';
import type { Settings } from '@/lib/bridge';
import { CLAUDE_CAPABILITIES } from '@/lib/provider-capabilities';

import { buildCards, type CardContext } from './settings-cards';
import { SettingsCard } from './SettingsCard';

/** A Codex-like descriptor — derived from the Claude default via spread (a test
 *  fixture, not a hand-copied source of truth; the real Codex matrix arrives over
 *  the wire). Mirrors the fixture used by `NewTaskForm.test.tsx` /
 *  `provider-capabilities.test.tsx`. */
const CODEX_CAPS: ProviderCapabilities = {
  ...CLAUDE_CAPABILITIES,
  id: 'codex',
  label: 'Codex',
  supportsMaxTurns: false,
  supportsMaxBudget: false,
};

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
  logLevel: 'info',
  projectOverrides: {},
};

/** A minimal `CardContext` for the `models` page — only the fields the Limits
 *  card's build path reads are exercised beyond their type-required presence. */
function contextWith(defaultProviderCapabilities: ProviderCapabilities | null): CardContext {
  return {
    effective: {
      defaultModel: SETTINGS.defaultModel,
      defaultEffort: SETTINGS.defaultEffort,
      maxConcurrency: SETTINGS.maxConcurrency,
      permissionMode: SETTINGS.permissionMode,
      defaultRunMode: SETTINGS.defaultRunMode,
      maxTurns: SETTINGS.maxTurns,
      maxBudgetUsd: SETTINGS.maxBudgetUsd,
      mcpServers: SETTINGS.mcpServers,
      contextPackEnabled: SETTINGS.contextPackEnabled,
    },
    settings: SETTINGS,
    patchScoped: vi.fn(),
    patchGlobal: vi.fn(),
    activeProjectPath: null,
    appInfo: null,
    onRestartOnboarding: vi.fn(),
    isAppIdle: true,
    editors: [],
    onNavigate: vi.fn(),
    usageMeter: { enabled: false, enable: vi.fn(), disable: vi.fn() },
    defaultProviderCapabilities,
  };
}

/** The `Limits` card is the 3rd card built for the `models` page (Model &
 *  reasoning, Parallelism, Limits). */
function limitsCard(defaultProviderCapabilities: ProviderCapabilities | null) {
  const cards = buildCards('models', contextWith(defaultProviderCapabilities));
  const card = cards.find((c) => c.title === 'Limits');
  if (card === undefined) throw new Error('Limits card not built');
  return card;
}

test('the Limits card caveats an unenforced ceiling when the default provider is Codex-like', async () => {
  const screen = render(<SettingsCard {...limitsCard(CODEX_CAPS)} />);
  await expect.element(screen.getByText('Max turns', { exact: true })).toBeInTheDocument();
  const note = screen.getByText(/does not enforce/i);
  await expect.element(note).toBeInTheDocument();
  await expect.element(note).toHaveTextContent(/Codex/);
  await expect.element(note).toHaveTextContent(/ignored/);
});

test('the Limits card renders no caveat for a Claude default', async () => {
  const screen = render(<SettingsCard {...limitsCard(CLAUDE_CAPABILITIES)} />);
  await expect.element(screen.getByText('Max turns', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText(/does not enforce/i)).not.toBeInTheDocument();
});

test('the Limits card renders no caveat while capabilities are unresolved (null, fail-open)', async () => {
  const screen = render(<SettingsCard {...limitsCard(null)} />);
  await expect.element(screen.getByText('Max turns', { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText(/does not enforce/i)).not.toBeInTheDocument();
});
