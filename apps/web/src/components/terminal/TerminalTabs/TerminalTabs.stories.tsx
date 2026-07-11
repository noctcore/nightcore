import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';

import type { PersistedTerminalInfo, TerminalSessionInfo } from '@/lib/bridge';

import { TerminalTabs } from './TerminalTabs';

function session(over: Partial<TerminalSessionInfo> & { id: string }): TerminalSessionInfo {
  return {
    cwd: `/Users/dev/nightcore/.nightcore/worktrees/${over.id}`,
    shell: '/bin/zsh',
    confined: false,
    cols: 80,
    rows: 24,
    alive: true,
    createdAt: Date.now(),
    title: null,
    titleSource: null,
    ...over,
  };
}

function persisted(id: string): PersistedTerminalInfo {
  return {
    id,
    cwd: `/Users/dev/nightcore/.nightcore/worktrees/${id}`,
    shell: '/bin/zsh',
    confined: false,
    createdAt: 0,
    updatedAt: 1,
    title: null,
    titleSource: null,
  };
}

const SESSIONS: TerminalSessionInfo[] = [
  session({ id: 'task-42' }),
  session({ id: 'task-91' }),
  session({ id: 'task-12' }),
];

const meta = {
  title: 'Terminal/TerminalTabs',
  component: TerminalTabs,
  parameters: { layout: 'padded' },
  args: {
    sessions: SESSIONS,
    restored: [],
    activeId: 'task-91',
    canAddTab: true,
    attention: {},
    viewMode: 'tabs',
    broadcastArmed: false,
    broadcastEligible: true,
    attentionWaiting: 0,
    ungovernedIds: new Set<string>(),
    onSelect: fn(),
    onClose: fn(),
    onDismiss: fn(),
    onNewTab: fn(),
    onRename: fn(),
    onToggleViewMode: fn(),
    onToggleBroadcast: fn(),
    onJumpAttention: fn(),
  },
} satisfies Meta<typeof TerminalTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three tabs, the middle one active. */
export const Populated: Story = {};

/** A task-linked / Claude-launched tab shows the "ungoverned" warning marker. */
export const WithUngovernedTab: Story = {
  args: { ungovernedIds: new Set(['task-42']) },
};

/** No sessions — only the "+" new-tab affordance. */
export const Empty: Story = { args: { sessions: [], activeId: null } };

/** A confined session shows the distinct lock identity marker (PR C lights this up;
 *  the variant already renders from `session.confined`). */
export const WithConfinedTab: Story = {
  args: {
    sessions: [
      session({ id: 'task-42' }),
      session({ id: 'task-91', confined: true }),
    ],
    activeId: 'task-91',
  },
};

/** Live tabs plus restored (read-only) tabs from a prior run, rendered dimmed with
 *  a history marker after the live ones. */
export const WithRestoredTabs: Story = {
  args: {
    sessions: [session({ id: 'task-42' })],
    restored: [persisted('task-77'), persisted('task-88')],
    activeId: 'task-77',
  },
};

/** At the 12-session cap — the new-tab button is disabled. */
export const CapReached: Story = {
  args: {
    sessions: Array.from({ length: 12 }, (_, i) => session({ id: `task-${i}` })),
    activeId: 'task-0',
    canAddTab: false,
  },
};

/** A manually renamed tab (decision 5) shows its custom title, not the cwd leaf. */
export const WithCustomTitle: Story = {
  args: {
    sessions: [
      session({ id: 'task-42', title: 'deploy shell' }),
      session({ id: 'task-91' }),
    ],
    activeId: 'task-91',
  },
};

/** Has-output badges (T11) on the two inactive tabs; the active tab never badges. */
export const WithActivityBadges: Story = {
  args: {
    activeId: 'task-91',
    attention: {
      'task-42': { unread: 3, needsAttention: false },
      'task-12': { unread: 128, needsAttention: false },
    },
  },
};

/** Needs-attention (T11): an OSC/BEL completion fired on an off-screen tab shows the
 *  LOUD warning dot, and the "jump to next waiting terminal" affordance appears. */
export const WithAttentionBadges: Story = {
  args: {
    activeId: 'task-91',
    attention: {
      'task-42': { unread: 5, needsAttention: true },
      'task-12': { unread: 2, needsAttention: false },
    },
    attentionWaiting: 1,
  },
  play: async ({ args, canvas }) => {
    await expect(canvas.getByLabelText('Waiting for you — a command finished')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: /Jump to the next of 1 waiting/ }));
    await expect(args.onJumpAttention).toHaveBeenCalled();
  },
};

/** Play test: clicking a tab selects it. */
export const SelectsTab: Story = {
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('tab', { name: /task-12/ }));
    await expect(args.onSelect).toHaveBeenCalledWith('task-12');
  },
};

/** Play test: double-clicking a tab label opens the inline rename input; Enter
 *  commits the new name via `onRename`. */
export const RenamesTab: Story = {
  play: async ({ args, canvas }) => {
    await userEvent.dblClick(canvas.getByRole('tab', { name: /task-91/ }));
    const input = canvas.getByRole('textbox', { name: /Rename/ });
    await userEvent.clear(input);
    await userEvent.type(input, 'deploy shell{Enter}');
    await expect(args.onRename).toHaveBeenCalledWith('task-91', 'deploy shell');
  },
};

/** In grid mode the toggle offers to switch back to Tabs view, and the broadcast-input
 *  toggle appears beside it (grid-only, round-2 PR B). */
export const GridMode: Story = {
  args: { viewMode: 'grid' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: 'Tabs view' })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Broadcast input' })).toBeInTheDocument();
  },
};

/** Play test: clicking the view-mode toggle flips the mode via `onToggleViewMode`. */
export const TogglesViewMode: Story = {
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Grid view' }));
    await expect(args.onToggleViewMode).toHaveBeenCalled();
  },
};

/** The broadcast toggle is grid-only — it never renders in tabs view. */
export const NoBroadcastInTabs: Story = {
  play: async ({ canvas }) => {
    expect(canvas.queryByRole('button', { name: /Broadcast/ })).toBeNull();
  },
};

/** Armed broadcast: the toggle shows its LOUD active state (round-2 PR B, § B.3). */
export const BroadcastArmed: Story = {
  args: { viewMode: 'grid', broadcastArmed: true },
  play: async ({ canvas }) => {
    const toggle = canvas.getByRole('button', { name: 'Broadcasting to all panes' });
    await expect(toggle).toBeInTheDocument();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  },
};

/** With fewer than two visible panes the broadcast toggle is disabled — nothing to
 *  broadcast to. */
export const BroadcastIneligible: Story = {
  args: { viewMode: 'grid', broadcastEligible: false },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: 'Broadcast input' })).toBeDisabled();
  },
};

/** Play test: clicking the broadcast toggle arms via `onToggleBroadcast`. */
export const TogglesBroadcast: Story = {
  args: { viewMode: 'grid' },
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Broadcast input' }));
    await expect(args.onToggleBroadcast).toHaveBeenCalled();
  },
};
