import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';

import type { WorktreeDiff } from '@/lib/bridge';

import { portaledSurface } from '../../../../.storybook/test-utils';
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
    // `null` keeps the per-file patch fetch idle in Storybook (no Tauri), so an
    // expanded row degrades to the empty-patch note rather than a live call.
    taskId: null,
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
  play: async () => {
    const canvas = portaledSurface();
    // Paths render leaf-preserving (dir + filename spans); the full path lives on title.
    await expect(canvas.getByTitle('apps/web/src/lib/diff.ts')).toBeInTheDocument();
    await expect(canvas.getByTitle('scratch/notes.md')).toBeInTheDocument();
  },
};

/** Play test: clicking the close affordance invokes onClose. */
export const ClosesOnButton: Story = {
  play: async ({ args }) => {
    const canvas = portaledSurface();
    await userEvent.click(canvas.getByRole('button', { name: /close/i }));
    await expect(args.onClose).toHaveBeenCalled();
  },
};

/** Play test: the empty diff renders the empty state. */
export const ShowsEmptyState: Story = {
  args: { diff: { files: [], summary: '', additions: 0, deletions: 0 } },
  play: async () => {
    const canvas = portaledSurface();
    await expect(canvas.getByText('No changed files')).toBeInTheDocument();
  },
};

/** Play test: nothing renders while closed. */
export const RendersNothingClosed: Story = {
  args: { open: false },
  play: async () => {
    const canvas = portaledSurface();
    await expect(canvas.queryByRole('dialog')).toBeNull();
  },
};

/** Play test: a file row is a toggle button that expands its inline patch, and a
 *  second click collapses it (aria-expanded tracks the open state). */
export const ExpandsAndCollapsesRow: Story = {
  play: async () => {
    const canvas = portaledSurface();
    const row = canvas.getByRole('button', { name: /scratch\/notes\.md/ });
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(row);
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    // No taskId in Storybook ⇒ the fetch stays idle ⇒ the empty-patch note shows.
    await expect(canvas.getByText('No textual changes to show.')).toBeInTheDocument();
    await userEvent.click(row);
    await expect(row).toHaveAttribute('aria-expanded', 'false');
  },
};
