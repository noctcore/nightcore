import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';

import { portaledSurface } from '../../../../.storybook/test-utils';
import { NewTabPicker } from './NewTabPicker';
import type { TerminalTarget } from './NewTabPicker.types';

const TARGETS: TerminalTarget[] = [
  { kind: 'repo', label: 'nightcore', path: '/Users/dev/nightcore', detail: '~/dev/nightcore' },
  {
    kind: 'worktree',
    label: 'nc/task-42',
    path: '/Users/dev/nightcore/.nightcore/worktrees/task-42',
    detail: 'Add terminal view',
  },
  {
    kind: 'worktree',
    label: 'nc/task-91',
    path: '/Users/dev/nightcore/.nightcore/worktrees/task-91',
    detail: 'Fix flaky test',
  },
];

const meta = {
  title: 'Terminal/NewTabPicker',
  component: NewTabPicker,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    targets: TARGETS,
    onPick: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof NewTabPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Repo root + two worktrees to choose from. */
export const Default: Story = {};

/** No project open — an empty note instead of targets. */
export const Empty: Story = { args: { targets: [] } };

/** A spawn error (the 8-session cap) surfaced inline; the picker stays open. */
export const CapReached: Story = {
  args: { error: 'terminal session limit reached (8) — close a tab first' },
};

/** A spawn is in flight — targets are disabled and an "Opening…" note shows. */
export const Busy: Story = { args: { busy: true } };

/** Play test: picking a target fires onPick with its absolute path. */
export const PicksTarget: Story = {
  play: async ({ args }) => {
    const canvas = portaledSurface();
    await userEvent.click(canvas.getByRole('button', { name: /nc\/task-42/ }));
    await expect(args.onPick).toHaveBeenCalledWith(
      '/Users/dev/nightcore/.nightcore/worktrees/task-42',
    );
  },
};
