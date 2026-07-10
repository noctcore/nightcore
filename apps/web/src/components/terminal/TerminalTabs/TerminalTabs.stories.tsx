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
    onSelect: fn(),
    onClose: fn(),
    onDismiss: fn(),
    onNewTab: fn(),
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

/** At the 8-session cap — the new-tab button is disabled. */
export const CapReached: Story = {
  args: {
    sessions: Array.from({ length: 8 }, (_, i) => session({ id: `task-${i}` })),
    activeId: 'task-0',
    canAddTab: false,
  },
};

/** Play test: clicking a tab selects it. */
export const SelectsTab: Story = {
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('tab', { name: /task-12/ }));
    await expect(args.onSelect).toHaveBeenCalledWith('task-12');
  },
};
