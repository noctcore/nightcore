import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { makeTaskActions, TASKS_BY_STATUS } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { Column } from './Column';
import type { ColumnProps } from './Column.types';

/** One stable no-op action group for every column story — the cards inside read
 *  their handlers from `TaskActionsContext` now, not props. */
const STORY_ACTIONS = makeTaskActions();

/** The story fixture: the column wrapped in the provider its cards require. */
function ColumnFixture(props: ColumnProps) {
  return (
    <TaskActionsProvider actions={STORY_ACTIONS}>
      <Column {...props} />
    </TaskActionsProvider>
  );
}

const meta = {
  title: 'Board/Column',
  component: ColumnFixture,
  args: {
    dotColor: 'oklch(80% .14 75)',
    selectedId: null,
    blockedIds: new Set<string>(),
    logCounts: {},
    onClear: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ height: '70vh', display: 'flex' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ColumnFixture>;

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
    title: 'Done',
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
