import type { Meta, StoryObj } from '@storybook/react-vite';

import { makeTask, SAMPLE_REVIEW_CHANGES, TRUST_GAUNTLET_FAILED, TRUST_VERIFIED } from '../_fixtures';
import { EvidenceBundle } from './EvidenceBundle';

const WORKTREE_TASK = makeTask({
  id: 't-review',
  status: 'waiting_approval',
  runMode: 'worktree',
  title: 'Wire up auth guard',
  review: SAMPLE_REVIEW_CHANGES,
});

const meta = {
  title: 'Board/EvidenceBundle',
  component: EvidenceBundle,
  decorators: [
    (Story) => (
      <div style={{ width: 440, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    task: WORKTREE_TASK,
    // `data` is the story override — no bridge fetch fires.
    data: { report: TRUST_VERIFIED, diff: { files: 3, additions: 128, deletions: 42 } },
  },
} satisfies Meta<typeof EvidenceBundle>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A clean receipt: gauntlet green, diff present, cost + ledger surfaced. */
export const Verified: Story = {};

/** The gauntlet failed — the reviewer sees the failing check verbatim before deciding. */
export const GauntletFailed: Story = {
  args: {
    data: { report: TRUST_GAUNTLET_FAILED, diff: { files: 5, additions: 210, deletions: 88 } },
  },
};

/** A worktree with no changes vs base — stated explicitly, never a fetch failure. */
export const NoDiff: Story = {
  args: {
    data: { report: TRUST_VERIFIED, diff: { files: 0, additions: 0, deletions: 0 } },
  },
};

/** A main-mode task has no worktree diff — the diff row is omitted entirely. */
export const MainMode: Story = {
  args: {
    task: makeTask({ id: 't-main', status: 'waiting_approval', runMode: 'main' }),
    data: { report: TRUST_VERIFIED, diff: null },
  },
};

/** Outside Tauri (browser preview) the receipt is unavailable — a quiet note. */
export const Unavailable: Story = {
  args: { data: { report: null, diff: null } },
};
