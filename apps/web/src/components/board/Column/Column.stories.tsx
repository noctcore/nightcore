import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Column } from './Column';
import { TASKS_BY_STATUS } from '../_fixtures';

const meta = {
  title: 'Board/Column',
  component: Column,
  args: {
    dotColor: 'oklch(80% .14 75)',
    selectedId: null,
    blockedIds: new Set<string>(),
    logCounts: {},
    onSelect: fn(),
    onRun: fn(),
    onCancel: fn(),
    onDelete: fn(),
    onClear: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ height: '70vh', display: 'flex' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Column>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: { title: 'Backlog', tasks: [], emptyText: 'Add a task to begin' },
};

export const InProgress: Story = {
  args: {
    title: 'In Progress',
    tasks: [TASKS_BY_STATUS.in_progress],
    logCounts: { 't-running': 7 },
  },
};

export const WaitingApproval: Story = {
  args: {
    title: 'Waiting Approval',
    dotColor: 'oklch(74% .13 248)',
    badge: 'M3',
    tasks: [],
    emptyText: 'Nothing awaiting approval',
  },
};

export const Verified: Story = {
  args: {
    title: 'Verified',
    dotColor: 'oklch(76% .15 152)',
    clearable: true,
    tasks: [TASKS_BY_STATUS.done],
  },
};

/** Play test: a clearable, non-empty column exposes Clear and fires onClear. */
export const ClearColumn: Story = {
  args: {
    title: 'Failed',
    dotColor: 'oklch(66% .2 22)',
    clearable: true,
    tasks: [TASKS_BY_STATUS.failed],
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /clear/i }));
    await expect(args.onClear).toHaveBeenCalled();
  },
};
