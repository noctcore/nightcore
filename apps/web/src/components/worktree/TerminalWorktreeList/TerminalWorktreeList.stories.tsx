import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { WorktreeInfo } from '@/lib/bridge';

import { TerminalWorktreeList } from './TerminalWorktreeList';

const CLEAN: WorktreeInfo = {
  branch: 'term/spike-auth',
  path: '/Users/dev/nightcore/.nightcore/worktrees-term/spike-auth',
  taskIds: [],
  dirty: false,
  aheadOfBase: 0,
  behindOfBase: 0,
  changedFiles: 0,
};

const DIRTY: WorktreeInfo = {
  branch: 'term/scratch',
  path: '/Users/dev/nightcore/.nightcore/worktrees-term/scratch',
  taskIds: [],
  dirty: true,
  aheadOfBase: 0,
  behindOfBase: 0,
  changedFiles: 3,
};

const meta = {
  title: 'Worktree/TerminalWorktreeList',
  component: TerminalWorktreeList,
  parameters: { layout: 'padded' },
  args: {
    worktrees: [CLEAN, DIRTY],
    onOpenTerminal: fn(),
    onDiscard: fn(),
  },
} satisfies Meta<typeof TerminalWorktreeList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two terminal worktrees, one clean and one with uncommitted changes. */
export const Default: Story = {};

/** No terminal worktrees — the group renders nothing (no empty-group flash). */
export const Empty: Story = { args: { worktrees: [] } };
