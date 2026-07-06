import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ToastProvider } from '@/components/ui';
import type { Task, WorktreeInfo } from '@/lib/bridge';
import { WorktreesProvider } from '@/lib/worktrees-context';

import { WorktreeView } from './WorktreeView';
import type { WorktreeViewProps } from './WorktreeView.types';

const WORKTREES: WorktreeInfo[] = [
  {
    branch: 'nc/api-client',
    path: '~/dev/p/.nightcore/worktrees/t1',
    taskIds: ['t1'],
    dirty: true,
    aheadOfBase: 2,
    behindOfBase: 0,
    changedFiles: 3,
  },
  {
    branch: 'nc/auth-guard',
    path: '~/dev/p/.nightcore/worktrees/t2',
    taskIds: ['t2'],
    dirty: false,
    aheadOfBase: 1,
    behindOfBase: 1,
    changedFiles: 0,
  },
];

// The view only reads id / title / branch off each task; a minimal shape keeps the
// fixture readable (stories are exempt from the strict component lint rules).
const TASKS = [
  { id: 't1', title: 'Add API client', branch: 'nc/api-client' },
  { id: 't2', title: 'Auth guard', branch: 'nc/auth-guard' },
] as unknown as Task[];

/** The story fixture: the view wrapped in the `WorktreesProvider` it now reads
 *  the live list + Refresh handler from. Those stay story ARGS so plays and
 *  tests keep overriding them per render. */
function WorktreeViewFixture({
  worktrees,
  onRefresh,
  ...props
}: WorktreeViewProps & { worktrees: WorktreeInfo[]; onRefresh?: () => void }) {
  return (
    <WorktreesProvider
      value={{
        worktrees,
        activeWorktree: null,
        setActiveWorktree: () => {},
        removeWorktree: () => {},
        refreshWorktrees: onRefresh ?? (() => {}),
      }}
    >
      <WorktreeView {...props} />
    </WorktreesProvider>
  );
}

const meta = {
  title: 'Worktree/WorktreeView',
  component: WorktreeViewFixture,
  args: { worktrees: WORKTREES, tasks: TASKS, onRefresh: fn() },
  decorators: [
    (Story) => (
      <ToastProvider>
        <div style={{ height: 520, width: 720 }}>
          <Story />
        </div>
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof WorktreeViewFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { worktrees: [] } };
