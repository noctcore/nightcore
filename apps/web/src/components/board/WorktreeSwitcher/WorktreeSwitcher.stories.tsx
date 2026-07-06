import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { WorktreeInfo } from '@/lib/bridge';
import {
  type ActiveWorktree,
  type RemovableWorktreeTab,
  WorktreesProvider,
} from '@/lib/worktrees-context';

import {
  MAIN_MODE_TASK,
  MANY_WORKTREE_TASKS,
  MANY_WORKTREES,
  TASKS_BY_STATUS,
  WORKTREES,
} from '../_fixtures';
import { WorktreeSwitcher } from './WorktreeSwitcher';
import type { WorktreeSwitcherProps } from './WorktreeSwitcher.types';

// A below-threshold task set: Main + two live worktrees (nc/api-client,
// nc/auth-guard) → 3 tabs, so the default stories exercise the inline path. The
// overflow/collapse path has its own stories driven by MANY_WORKTREES.
const INLINE_TASKS = [MAIN_MODE_TASK, TASKS_BY_STATUS.in_progress, TASKS_BY_STATUS.done];

/** The story fixture: the switcher wrapped in the `WorktreesProvider` it now
 *  reads its list/selection/handlers from. Those stay story ARGS so plays and
 *  tests keep overriding them per render. */
function WorktreeSwitcherFixture({
  worktrees,
  active,
  onSelect,
  onRemoveWorktree,
  ...props
}: WorktreeSwitcherProps & {
  worktrees: WorktreeInfo[];
  active: ActiveWorktree;
  onSelect?: (active: ActiveWorktree) => void;
  onRemoveWorktree?: (tab: RemovableWorktreeTab) => void;
}) {
  return (
    <WorktreesProvider
      value={{
        worktrees,
        activeWorktree: active,
        setActiveWorktree: onSelect ?? (() => {}),
        removeWorktree: onRemoveWorktree ?? (() => {}),
        refreshWorktrees: () => {},
      }}
    >
      <WorktreeSwitcher {...props} />
    </WorktreesProvider>
  );
}

const meta = {
  title: 'Board/WorktreeSwitcher',
  component: WorktreeSwitcherFixture,
  args: {
    tasks: INLINE_TASKS,
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
} satisfies Meta<typeof WorktreeSwitcherFixture>;

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

// --- Overflow / collapse path ------------------------------------------------

/** Above the threshold (Main + 6 worktrees): Main stays an inline tab and the six
 *  worktrees fold into the searchable collapsed select, whose trigger aggregates
 *  the count, a running spinner (two worktrees are live), and a diverged badge. */
export const ManyWorktreesCollapsed: Story = {
  args: { tasks: MANY_WORKTREE_TASKS, worktrees: MANY_WORKTREES },
};

/** A collapsed worktree is the active selection → the trigger reflects its branch
 *  label + active styling, and its row is marked selected inside the panel. */
export const CollapsedWorktreeSelected: Story = {
  args: { tasks: MANY_WORKTREE_TASKS, worktrees: MANY_WORKTREES, active: 'nc/rate-limiter' },
};

/** Play test: open the collapsed select, filter by task title, and pick a row. */
export const CollapsedSearchAndSelect: Story = {
  args: { tasks: MANY_WORKTREE_TASKS, worktrees: MANY_WORKTREES },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /worktrees/i }));
    const search = canvas.getByRole('combobox', { name: /search worktrees/i });
    // "rate limiter" is the task title on nc/rate-limiter — search hits titles too.
    await userEvent.type(search, 'rate limiter');
    await userEvent.click(canvas.getByRole('option', { name: /nc\/rate-limiter/i }));
    await expect(args.onSelect).toHaveBeenCalledWith('nc/rate-limiter');
  },
};

/** Play test: the collapsed select is keyboard-navigable — the first row is
 *  pre-highlighted, so ArrowDown moves to the second worktree and Enter picks it. */
export const CollapsedKeyboardSelect: Story = {
  args: { tasks: MANY_WORKTREE_TASKS, worktrees: MANY_WORKTREES },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /worktrees/i }));
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(args.onSelect).toHaveBeenCalledWith('nc/auth-guard');
  },
};
