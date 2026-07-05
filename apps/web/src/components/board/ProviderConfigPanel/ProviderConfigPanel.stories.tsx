import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { ProviderConfigSnapshot } from '@/lib/bridge';

import { ProviderConfigPanel } from './ProviderConfigPanel';
import type { ProviderConfigData } from './ProviderConfigPanel.types';

/** A snapshot exercising every per-section tri-state: MCP + skills supported,
 *  subagents unavailable (a degraded section), and supported scalar extras. */
const MIXED_SNAPSHOT: ProviderConfigSnapshot = {
  providerId: 'claude',
  providerLabel: 'Claude',
  projectPath: '/proj',
  mcp: {
    status: 'supported',
    mcpServers: [
      {
        name: 'github',
        status: 'connected',
        scope: 'project',
        transport: 'http',
        toolCount: 14,
      },
      { name: 'filesystem', status: 'pending', scope: 'user', transport: 'stdio' },
      { name: 'sentry', status: 'needs-auth', scope: 'user', transport: 'sse' },
    ],
  },
  skills: {
    status: 'supported',
    skills: [
      { name: 'add-feature', description: 'Plan and ship a new feature' },
      { name: 'fix-bug', description: 'Diagnose an integration that should work' },
    ],
  },
  subagents: { status: 'unavailable', error: 'probe timed out' },
  model: 'claude-opus-4-8',
  permissionMode: 'acceptEdits',
  outputStyle: 'default',
  extrasStatus: 'supported',
};

/** A second-provider snapshot: every section declines (`unsupported`), proving the
 *  panel degrades gracefully with no provider-specific branches. */
const UNSUPPORTED_SNAPSHOT: ProviderConfigSnapshot = {
  providerId: 'codex',
  providerLabel: 'Codex',
  projectPath: '/proj',
  mcp: { status: 'unsupported' },
  skills: { status: 'unsupported' },
  subagents: { status: 'unsupported' },
  extrasStatus: 'unsupported',
};

/** A strict-isolation snapshot: supported sections with EMPTY lists (distinct from
 *  unsupported). */
const EMPTY_SNAPSHOT: ProviderConfigSnapshot = {
  providerId: 'claude',
  providerLabel: 'Claude',
  projectPath: '/proj',
  mcp: { status: 'supported', mcpServers: [] },
  skills: { status: 'supported', skills: [] },
  subagents: { status: 'supported', subagents: [] },
  model: 'claude-opus-4-8',
  permissionMode: 'plan',
  extrasStatus: 'supported',
};

const dataFor = (snapshot: ProviderConfigSnapshot): ProviderConfigData => ({
  load: () => Promise.resolve(snapshot),
});

const meta = {
  title: 'Board/ProviderConfigPanel',
  component: ProviderConfigPanel,
  args: {
    open: true,
    projectPath: '/proj',
    projectName: 'nightcore',
    onClose: fn(),
    data: dataFor(MIXED_SNAPSHOT),
  },
} satisfies Meta<typeof ProviderConfigPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Mixed states: supported MCP/skills, a degraded (unavailable) subagents section. */
export const Default: Story = {};

/** A provider that declines every section — all render "Not available for this
 *  provider" with zero new branches. */
export const Unsupported: Story = {
  args: { data: dataFor(UNSUPPORTED_SNAPSHOT) },
};

/** Strict isolation: supported sections with empty lists (not unsupported). */
export const Empty: Story = {
  args: { data: dataFor(EMPTY_SNAPSHOT) },
};

/** The whole read failed (no active project / transport down) — soft error + retry. */
export const LoadFailed: Story = {
  args: {
    data: { load: () => Promise.reject(new Error('no active project to inspect')) },
  },
};

/** The loading state — a `load` that never resolves, so the skeleton sections
 *  stay visible. Confirms the placeholder mirrors the real section layout. */
export const Loading: Story = {
  args: {
    data: { load: () => new Promise<ProviderConfigSnapshot>(() => {}) },
  },
};
