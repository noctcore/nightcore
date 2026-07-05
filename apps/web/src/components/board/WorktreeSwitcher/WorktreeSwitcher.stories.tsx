import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { MAIN_MODE_TASK, TASKS_BY_STATUS, WORKTREES } from '../_fixtures';
import { WorktreeSwitcher } from './WorktreeSwitcher';

const ALL_TASKS = [MAIN_MODE_TASK, ...Object.values(TASKS_BY_STATUS)];

const meta = {
  title: 'Board/WorktreeSwitcher',
  component: WorktreeSwitcher,
  args: {
    tasks: ALL_TASKS,
    worktrees: WORKTREES,
    active: null,
    onSelect: fn(),
    onRemoveWorktree: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 720 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorktreeSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MainSelected: Story = {};

export const WorktreeSelected: Story = { args: { active: 'nc/api-client' } };

/** With no live worktrees, tabs fall back to the distinct task branches. */
export const FallbackToTaskBranches: Story = { args: { worktrees: [] } };

/** Only main-mode tasks and no worktrees → just the Main tab → renders nothing. */
export const HiddenWhenOnlyMain: Story = {
  args: { tasks: [MAIN_MODE_TASK], worktrees: [] },
};

/** Play test: clicking a worktree tab selects its branch. */
export const SelectsWorktree: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('tab', { name: /nc\/api-client/i }));
    await expect(args.onSelect).toHaveBeenCalledWith('nc/api-client');
  },
};

/** Play test: clicking Main selects null. */
export const SelectsMain: Story = {
  args: { active: 'nc/api-client' },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('tab', { name: /^main/i }));
    await expect(args.onSelect).toHaveBeenCalledWith(null);
  },
};

/** Play test: the per-tab actions menu's "Remove worktree" item reports the tab. */
export const RemovesWorktree: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /worktree actions for nc\/api-client/i }));
    await userEvent.click(canvas.getByRole('menuitem', { name: /remove worktree/i }));
    await expect(args.onRemoveWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'nc/api-client', taskIds: expect.arrayContaining(['t-running']) }),
    );
  },
};
