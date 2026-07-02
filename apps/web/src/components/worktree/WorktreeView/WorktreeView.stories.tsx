import type { Meta, StoryObj } from '@storybook/react-vite';

import { ToastProvider } from '@/components/ui';
import type { Task, WorktreeInfo } from '@/lib/bridge';

import { WorktreeView } from './WorktreeView';

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

const meta = {
  title: 'Worktree/WorktreeView',
  component: WorktreeView,
  args: { worktrees: WORKTREES, tasks: TASKS },
  decorators: [
    (Story) => (
      <ToastProvider>
        <div style={{ height: 520, width: 720 }}>
          <Story />
        </div>
      </ToastProvider>
    ),
  ],
} satisfies Meta<typeof WorktreeView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { worktrees: [] } };
