import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { WorktreeInfo } from '@/lib/bridge';

import { WorktreeManager } from './WorktreeManager';

/** Build a WorktreeInfo fixture with sane defaults (clean, in sync). */
function wt(over: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    branch: 'nc/task',
    path: '/repo/.worktrees/nc-task',
    taskIds: ['task'],
    dirty: false,
    aheadOfBase: 0,
    behindOfBase: 0,
    changedFiles: 0,
    ...over,
  };
}

const TITLES: Record<string, string> = {
  'task-1': 'Add OAuth login flow',
  'task-2': 'Refactor the parser',
  'task-3': 'Tune the scheduler',
};

/** A single dirty worktree reused by the action play tests. */
const SINGLE: WorktreeInfo[] = [
  wt({ branch: 'nc/task-7', taskIds: ['task-7'], dirty: true, changedFiles: 5, aheadOfBase: 2 }),
];

/** A worktree that owns no task — its actions must disable. */
const ORPHAN: WorktreeInfo[] = [
  wt({ branch: 'nc/orphan', taskIds: [], dirty: true, changedFiles: 1 }),
];

const meta = {
  title: 'Worktree/WorktreeManager',
  component: WorktreeManager,
  args: {
    worktrees: [
      wt({ branch: 'nc/task-1', taskIds: ['task-1'], aheadOfBase: 2 }),
      wt({ branch: 'nc/task-2', taskIds: ['task-2'], dirty: true, changedFiles: 5 }),
      wt({ branch: 'nc/task-3', taskIds: ['task-3'], aheadOfBase: 1, behindOfBase: 4 }),
    ],
    titleForTask: (id: string) => TITLES[id],
    onViewDiff: fn(),
    onPreviewMerge: fn(),
    onDiscard: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 620, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorktreeManager>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { worktrees: [] } };

export const Loading: Story = { args: { loading: true } };

export const Single: Story = {
  args: { worktrees: SINGLE, titleForTask: () => 'Wire the webhook handler' },
};

export const Orphaned: Story = { args: { worktrees: ORPHAN } };

/** Play test: a diverged worktree (ahead AND behind) shows the red flag. */
export const Diverged: Story = {
  args: {
    worktrees: [wt({ branch: 'nc/task-9', taskIds: ['task-9'], aheadOfBase: 2, behindOfBase: 3 })],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText(/diverged from base/i)).toBeInTheDocument();
  },
};

/** Play test: View diff fires with the worktree's primary task id. */
export const ViewsDiff: Story = {
  args: { worktrees: SINGLE },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /diff/i }));
    await expect(args.onViewDiff).toHaveBeenCalledWith('task-7');
  },
};

/** Play test: Discard fires with the primary task id. */
export const Discards: Story = {
  args: { worktrees: SINGLE },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /discard/i }));
    await expect(args.onDiscard).toHaveBeenCalledWith('task-7');
  },
};

/** Play test: actions are disabled when the worktree owns no task. */
export const OrphanedDisables: Story = {
  args: { worktrees: ORPHAN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: /diff/i })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: /discard/i })).toBeDisabled();
  },
};
