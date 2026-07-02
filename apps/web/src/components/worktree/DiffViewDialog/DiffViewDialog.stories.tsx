import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { WorktreeDiff } from '@/lib/bridge';

import { DiffViewDialog } from './DiffViewDialog';

const sampleDiff: WorktreeDiff = {
  files: [
    {
      path: 'apps/web/src/components/board/Board/Board.tsx',
      status: 'modified',
      additions: 24,
      deletions: 8,
    },
    {
      path: 'apps/web/src/components/worktree/DiffViewDialog/DiffViewDialog.tsx',
      status: 'added',
      additions: 96,
      deletions: 0,
    },
    { path: 'apps/web/src/lib/legacy-helper.ts', status: 'deleted', additions: 0, deletions: 41 },
    { path: 'apps/web/src/lib/diff.ts', status: 'renamed', additions: 3, deletions: 3 },
    { path: 'scratch/notes.md', status: 'untracked', additions: 12, deletions: 0 },
  ],
  summary: '5 files changed, 135 insertions(+), 52 deletions(-)',
  additions: 135,
  deletions: 52,
};

const meta = {
  title: 'Worktree/DiffViewDialog',
  component: DiffViewDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    diff: sampleDiff,
    onClose: fn(),
  },
} satisfies Meta<typeof DiffViewDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    diff: { files: [], summary: 'No changes', additions: 0, deletions: 0 },
  },
};

export const Loading: Story = {
  args: { loading: true, diff: null },
};

export const Closed: Story = {
  args: { open: false },
};

/** Play test: every changed file path is listed. */
export const ListsFiles: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('apps/web/src/lib/diff.ts')).toBeInTheDocument();
    await expect(canvas.getByText('scratch/notes.md')).toBeInTheDocument();
  },
};

/** Play test: clicking the close affordance invokes onClose. */
export const ClosesOnButton: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /close/i }));
    await expect(args.onClose).toHaveBeenCalled();
  },
};

/** Play test: the empty diff renders the empty state. */
export const ShowsEmptyState: Story = {
  args: { diff: { files: [], summary: '', additions: 0, deletions: 0 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No changed files')).toBeInTheDocument();
  },
};

/** Play test: nothing renders while closed. */
export const RendersNothingClosed: Story = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('dialog')).toBeNull();
  },
};
