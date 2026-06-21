import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { TaskCard } from './TaskCard';
import { BLOCKED_TASK, TASKS_BY_STATUS } from '../_fixtures';

const meta = {
  title: 'Board/TaskCard',
  component: TaskCard,
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
} satisfies Meta<typeof TaskCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Backlog: Story = { args: { task: TASKS_BY_STATUS.backlog } };
export const Ready: Story = { args: { task: TASKS_BY_STATUS.ready } };
export const Blocked: Story = { args: { task: BLOCKED_TASK, blocked: true } };
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
