import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { BLOCKED_TASK, MAIN_MODE_TASK, makeTaskActions, TASKS_BY_STATUS } from '../_fixtures';
import { TaskActionsProvider, type TaskDetailActions } from '../actions';
import { UsageHotProvider, type UsageHotWindow } from '../usage-hot';
import { TaskCard } from './TaskCard';
import type { TaskCardProps } from './TaskCard.types';

/** The story fixture: the card wrapped in the `TaskActionsProvider` it now reads
 *  its action handlers from. The handlers stay story ARGS so plays and tests keep
 *  overriding them per render. */
function TaskCardFixture({
  onSelect,
  onRun,
  onCancel,
  onDelete,
  onApprove,
  onRefine,
  onCommit,
  onMerge,
  isActionPending,
  usageHot = null,
  ...props
}: TaskCardProps &
  Partial<
    Pick<
      TaskDetailActions,
      | 'onSelect'
      | 'onRun'
      | 'onCancel'
      | 'onDelete'
      | 'onApprove'
      | 'onRefine'
      | 'onCommit'
      | 'onMerge'
      | 'isActionPending'
    >
  > & { usageHot?: UsageHotWindow | null }) {
  return (
    <TaskActionsProvider
      actions={makeTaskActions({
        onSelect,
        onRun,
        onCancel,
        onDelete,
        onApprove,
        onRefine,
        onCommit,
        onMerge,
        isActionPending,
      })}
    >
      <UsageHotProvider value={usageHot}>
        <TaskCard {...props} />
      </UsageHotProvider>
    </TaskActionsProvider>
  );
}

/** A hot Claude 5h window over the throttle threshold — drives the advisory chip. */
const HOT_WINDOW: UsageHotWindow = {
  provider: 'claude',
  windowLabel: 'Session (5h)',
  usedPercent: 93,
  resetsAt: null,
};

const meta = {
  title: 'Board/TaskCard',
  component: TaskCardFixture,
  args: {
    selected: false,
    onSelect: fn(),
    onRun: fn(),
    onCancel: fn(),
    onDelete: fn(),
    onApprove: fn(),
    onRefine: fn(),
    onCommit: fn(),
    onMerge: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 300 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskCardFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Backlog: Story = { args: { task: TASKS_BY_STATUS.backlog } };
export const Ready: Story = { args: { task: TASKS_BY_STATUS.ready } };
export const Blocked: Story = {
  args: {
    task: BLOCKED_TASK,
    blocked: true,
    // The resolved dependency (id → title) the human-readable blocked chip names.
    blockedBy: [{ id: 't-running', title: 'Generate API client', satisfied: false }],
  },
};
export const Running: Story = {
  args: { task: TASKS_BY_STATUS.in_progress, logCount: 7 },
};
/** A task in the post-build verification phase — the "reviewing" pulse + chip. */
export const Verifying: Story = {
  args: { task: TASKS_BY_STATUS.verifying, logCount: 3 },
};
export const WaitingApproval: Story = {
  args: { task: TASKS_BY_STATUS.waiting_approval },
};
/** A verified, passed task — its Verified badge shows beside the title. */
export const Done: Story = { args: { task: TASKS_BY_STATUS.done } };
export const Failed: Story = { args: { task: TASKS_BY_STATUS.failed } };

export const Selected: Story = {
  args: { task: TASKS_BY_STATUS.in_progress, selected: true },
};

/** Play test: clicking the card body selects it via onSelect(id). */
export const SelectsOnClick: Story = {
  args: { task: TASKS_BY_STATUS.done },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByRole('button', { name: /wire up auth guard/i });
    await userEvent.click(card);
    await expect(args.onSelect).toHaveBeenCalledWith('t-done');
  },
};

/** Play test: the running card's Cancel button invokes onCancel(id). */
export const CancelRun: Story = {
  args: { task: TASKS_BY_STATUS.in_progress },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /cancel run/i }));
    await expect(args.onCancel).toHaveBeenCalledWith('t-running');
  },
};

/** A running task with a parked permission prompt — pulses + "needs approval". */
export const NeedsApproval: Story = {
  args: { task: TASKS_BY_STATUS.in_progress, needsApproval: true, logCount: 2 },
};

/** A verified task already committed — its primary action is now Merge. */
export const Committed: Story = {
  args: { task: { ...TASKS_BY_STATUS.done, committed: true } },
};

/** A verified task merged into the base — the action shows disabled "Merged". */
export const Merged: Story = {
  args: { task: { ...TASKS_BY_STATUS.done, committed: true, merged: true } },
};

/** A verified task whose merge hit a conflict — surfaces the conflict chip. */
export const MergeConflict: Story = {
  args: { task: { ...TASKS_BY_STATUS.done, committed: true, conflict: true } },
};

/** A main-mode task — shows the "main" chip and no branch (it edits in place). */
export const MainMode: Story = {
  args: { task: { ...MAIN_MODE_TASK, committed: false } },
};

/** A committed main-mode task — Merge is suppressed for a disabled "Committed". */
export const MainModeCommitted: Story = {
  args: { task: MAIN_MODE_TASK },
};

/** Play test: Approve on a waiting card invokes onApprove(id). */
export const ApprovePlan: Story = {
  args: { task: TASKS_BY_STATUS.waiting_approval },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /approve/i }));
    await expect(args.onApprove).toHaveBeenCalledWith('t-waiting');
  },
};

/** Play test: Commit on a verified card invokes onCommit(id). */
export const CommitVerified: Story = {
  args: { task: TASKS_BY_STATUS.done },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /commit/i }));
    await expect(args.onCommit).toHaveBeenCalledWith('t-done');
  },
};

/** A draggable card — carries the grab affordance and the @dnd-kit keyboard
 *  attributes (role/tabIndex) that make it pointer-free movable across columns.
 *  The cross-column move itself is resolved by the board's `<DndContext>`. */
export const Draggable: Story = {
  args: { task: TASKS_BY_STATUS.backlog, draggable: true },
};

/** Usage hot (spec 2026-07-11): a backlog card shows the advisory "usage high" chip
 *  beside Run — but the Run button stays ENABLED (manual starts are never blocked). */
export const UsageHigh: Story = {
  args: { task: TASKS_BY_STATUS.backlog, usageHot: HOT_WINDOW },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/usage high/i)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /^run$/i })).toBeEnabled();
  },
};

/** Usage hot on a failed card — the chip sits beside Retry, which stays enabled. */
export const UsageHighRetry: Story = {
  args: { task: TASKS_BY_STATUS.failed, usageHot: HOT_WINDOW },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/usage high/i)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /^retry$/i })).toBeEnabled();
  },
};
