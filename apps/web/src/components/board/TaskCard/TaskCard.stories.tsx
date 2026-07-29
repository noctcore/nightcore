import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { RunOrderProjection } from '@/lib/bridge';

import { BLOCKED_TASK, MAIN_MODE_TASK, makeTaskActions, TASKS_BY_STATUS } from '../_fixtures';
import { TaskActionsProvider, type TaskDetailActions } from '../actions';
import { EMPTY_RUN_ORDER, RunOrderProvider } from '../run-order';
import { TaskSelectionProvider } from '../selection';
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
  runOrder = EMPTY_RUN_ORDER,
  bulkSelectedIds = [],
  onToggleBulk,
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
  > & {
    usageHot?: UsageHotWindow | null;
    /** The projected run order the card reads its position chip from. */
    runOrder?: RunOrderProjection;
    /** Ids in the board's multi-select — drives the card's checkbox state. */
    bulkSelectedIds?: string[];
    /** Spy for the multi-select toggle. */
    onToggleBulk?: (id: string) => void;
  }) {
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
        <RunOrderProvider value={runOrder}>
          <TaskSelectionProvider
            value={{
              selectedIds: new Set(bulkSelectedIds),
              toggle: (id) => onToggleBulk?.(id),
              clear: () => {},
              select: () => {},
            }}
          >
            <TaskCard {...props} />
          </TaskSelectionProvider>
        </RunOrderProvider>
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
/** A task in the post-build verification phase — the "verifying" chip + ring glow. */
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

/** A running task with a parked permission prompt — pulses + "needs input". */
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

/** Run-order transparency (#402): the card names its projected position. Position 1 reads
 *  as `next` and carries the primary tone — the next auto-loop pass starts it. */
export const RunOrderNext: Story = {
  args: {
    task: TASKS_BY_STATUS.backlog,
    runOrder: {
      ...EMPTY_RUN_ORDER,
      entries: [
        { taskId: 't-backlog', position: 1, wave: 0, startsNow: true, blockedBy: [] },
      ],
      freeSlots: 1,
      maxConcurrency: 1,
      startsNowCount: 1,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('next')).toBeInTheDocument();
  },
};

/** A chained task three passes out — muted `#4` rather than the primary "next" tone. */
export const RunOrderQueued: Story = {
  args: {
    task: TASKS_BY_STATUS.backlog,
    runOrder: {
      ...EMPTY_RUN_ORDER,
      entries: [
        { taskId: 't-backlog', position: 4, wave: 3, startsNow: false, blockedBy: ['x'] },
      ],
      freeSlots: 2,
      maxConcurrency: 2,
      startsNowCount: 0,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('#4')).toBeInTheDocument();
  },
};

/** Multi-select (#402): the card's checkbox, checked. */
export const BulkSelected: Story = {
  args: { task: TASKS_BY_STATUS.backlog, bulkSelectedIds: ['t-backlog'] },
};

/** Play test: the checkbox toggles this card's multi-select membership WITHOUT opening the
 *  task (the action row stops propagation) — the contract that keeps selection, drag, and
 *  card-open from fighting. */
export const BulkToggleDoesNotOpenTheTask: Story = {
  args: { task: TASKS_BY_STATUS.backlog, onToggleBulk: fn() },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('checkbox', { name: /select task/i }));
    await expect(args.onToggleBulk).toHaveBeenCalledWith('t-backlog');
    await expect(args.onSelect).not.toHaveBeenCalled();
  },
};
