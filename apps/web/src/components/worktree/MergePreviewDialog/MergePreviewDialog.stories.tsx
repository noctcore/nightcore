import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent } from 'storybook/test';

import type { MergePreview } from '@/lib/bridge';

import { portaledSurface } from '../../../../.storybook/test-utils';
import { MergePreviewDialog } from './MergePreviewDialog';

const FILES: MergePreview['files'] = [
  { path: 'apps/web/src/components/worktree/MergePreviewDialog.tsx', additions: 142, deletions: 0 },
  { path: 'apps/web/src/lib/bridge.ts', additions: 18, deletions: 4 },
];

const readyPreview: MergePreview = {
  status: 'ready',
  branch: 'feat/merge-preview',
  base: 'main',
  conflictFiles: [],
  files: FILES,
  additions: 160,
  deletions: 4,
  ahead: 3,
  behind: 0,
};

const upToDatePreview: MergePreview = {
  status: 'upToDate',
  branch: 'feat/merge-preview',
  base: 'main',
  conflictFiles: [],
  files: [],
  additions: 0,
  deletions: 0,
  ahead: 0,
  behind: 0,
};

const divergedPreview: MergePreview = {
  status: 'diverged',
  branch: 'feat/merge-preview',
  base: 'main',
  conflictFiles: [],
  files: FILES,
  additions: 160,
  deletions: 4,
  ahead: 3,
  behind: 7,
};

const conflictsPreview: MergePreview = {
  status: 'conflicts',
  branch: 'feat/merge-preview',
  base: 'main',
  conflictFiles: ['apps/web/src/lib/bridge.ts', 'apps/web/src/store/types.ts'],
  files: FILES,
  additions: 160,
  deletions: 22,
  ahead: 3,
  behind: 5,
};

const meta = {
  title: 'Worktree/MergePreviewDialog',
  component: MergePreviewDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    preview: readyPreview,
    onMerge: fn(),
    onUpdateFromBase: fn(),
    onClose: fn(),
    onViewDiff: fn(),
  },
} satisfies Meta<typeof MergePreviewDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};

export const UpToDate: Story = { args: { preview: upToDatePreview } };

export const Diverged: Story = { args: { preview: divergedPreview } };

export const Conflicts: Story = { args: { preview: conflictsPreview } };

export const Loading: Story = { args: { preview: null, loading: true } };

export const Merging: Story = { args: { merging: true } };

/** An update-from-base pull is in flight — the button shows a spinner + is disabled. */
export const UpdatingFromBase: Story = {
  args: { preview: divergedPreview, updatingFromBase: true },
};

/** Live terminal sessions open in this worktree (terminal spec, decision 2) — a
 *  blocking notice warns they'll be closed on merge. */
export const WithTerminalSessions: Story = { args: { terminalSessions: 3 } };

/** Play test: a ready preview enables Merge, and clicking it fires onMerge. */
export const MergesWhenReady: Story = {
  play: async ({ args }) => {
    const canvas = portaledSurface();
    const merge = canvas.getByRole('button', { name: 'Merge' });
    await expect(merge).toBeEnabled();
    await userEvent.click(merge);
    await expect(args.onMerge).toHaveBeenCalled();
  },
};

/** Play test: conflicts disable Merge, list the conflicting files, and show guidance. */
export const ConflictsBlockMerge: Story = {
  args: { preview: conflictsPreview },
  play: async () => {
    const canvas = portaledSurface();
    await expect(canvas.getByRole('button', { name: 'Merge' })).toBeDisabled();
    await expect(canvas.getByText(/2 conflicts — resolve before merging/i)).toBeInTheDocument();
    await expect(canvas.getByText('apps/web/src/store/types.ts')).toBeInTheDocument();
    await expect(
      canvas.getByText(/Resolve these files in the worktree, commit, then merge again\./i),
    ).toBeInTheDocument();
  },
};

/** Play test: while loading we show the conflict-check spinner copy and no Merge. */
export const ShowsLoading: Story = {
  args: { preview: null, loading: true },
  play: async () => {
    const canvas = portaledSurface();
    await expect(canvas.getByText(/Checking for conflicts…/i)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Merge' })).toBeDisabled();
  },
};

/** Play test: View full diff link fires onViewDiff. */
export const ViewsDiff: Story = {
  play: async ({ args }) => {
    const canvas = portaledSurface();
    await userEvent.click(canvas.getByRole('button', { name: 'View full diff' }));
    await expect(args.onViewDiff).toHaveBeenCalled();
  },
};

/** Play test: a behind-base branch raises the stale-branch hazard callout and the
 *  "Update from base" button, which fires onUpdateFromBase. */
export const BehindBaseWarns: Story = {
  args: { preview: divergedPreview },
  play: async ({ args }) => {
    const canvas = portaledSurface();
    await expect(canvas.getByText(/7 commits behind main/i)).toBeInTheDocument();
    await expect(canvas.getByText(/silently revert base-only changes/i)).toBeInTheDocument();
    const update = canvas.getByRole('button', { name: /Update from base/i });
    await userEvent.click(update);
    await expect(args.onUpdateFromBase).toHaveBeenCalled();
  },
};

/** Play test: a clean ahead-only branch shows neither the hazard nor the button,
 *  but still shows the muted merge-checkout note naming the base. */
export const CleanAheadNoHazard: Story = {
  play: async () => {
    const canvas = portaledSurface();
    await expect(canvas.queryByText(/behind main/i)).toBeNull();
    await expect(canvas.queryByRole('button', { name: /Update from base/i })).toBeNull();
    await expect(canvas.getByText(/Merging checks out/i)).toBeInTheDocument();
  },
};
