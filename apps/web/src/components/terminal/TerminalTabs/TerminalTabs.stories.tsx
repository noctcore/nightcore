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
    unread: {},
    viewMode: 'tabs',
    onSelect: fn(),
    onClose: fn(),
    onDismiss: fn(),
    onNewTab: fn(),
    onRename: fn(),
    onToggleViewMode: fn(),
  },
} satisfies Meta<typeof TerminalTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three tabs, the middle one active. */
export const Populated: Story = {};

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

/** Unread-output badges (decision 6c) on the two inactive tabs; the active tab
 *  never badges. */
export const WithActivityBadges: Story = {
  args: {
    activeId: 'task-91',
    unread: { 'task-42': 3, 'task-12': 128 },
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

/** In grid mode the toggle offers to switch back to Tabs view. */
export const GridMode: Story = {
  args: { viewMode: 'grid' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: 'Tabs view' })).toBeInTheDocument();
  },
};

/** Play test: clicking the view-mode toggle flips the mode via `onToggleViewMode`. */
export const TogglesViewMode: Story = {
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Grid view' }));
    await expect(args.onToggleViewMode).toHaveBeenCalled();
  },
};
