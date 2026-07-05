import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { PrStatus } from '@/lib/bridge';

import { PrStatusBlock } from './PrStatusBlock';

const SAMPLE: PrStatus = {
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BEHIND',
  reviewDecision: 'REVIEW_REQUIRED',
  checksPassed: 4,
  checksFailed: 1,
  checksPending: 2,
  baseRefName: 'main',
  headRefOid: 'a1b2c3d4',
  url: 'https://github.com/o/r/pull/128',
  number: 128,
  unpushedCommits: 0,
};

const meta = {
  title: 'PrReview/PrStatusBlock',
  component: PrStatusBlock,
  decorators: [
    (Story) => (
      <div className="w-[560px] p-4">
        <Story />
      </div>
    ),
  ],
  args: { prNumber: 128 },
} satisfies Meta<typeof PrStatusBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: { override: SAMPLE },
};

export const Merged: Story = {
  args: {
    override: {
      ...SAMPLE,
      state: 'MERGED',
      reviewDecision: 'APPROVED',
      checksPassed: 7,
      checksFailed: 0,
      checksPending: 0,
    },
  },
};

/** A clean, approved, green-checks PR — the "Ready to merge" readiness badge. */
export const ReadyToMerge: Story = {
  args: {
    override: {
      ...SAMPLE,
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      checksPassed: 7,
      checksFailed: 0,
      checksPending: 0,
    },
  },
};

/** Conflicts + failing checks with the remediation actions wired: both the
 *  "Resolve conflicts" and "Fix CI" human-gate buttons render on their rows. */
export const NeedsRemediation: Story = {
  args: {
    override: {
      ...SAMPLE,
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      checksPassed: 3,
      checksFailed: 2,
      checksPending: 0,
    },
    actions: { onFixCi: fn(), onResolveConflicts: fn(), fixBusy: false },
  },
};

/** The same remediation surface while a fix is already in flight — the buttons
 *  stay focusable but inert (aria-disabled + the sr-only reason). */
export const RemediationBusy: Story = {
  args: {
    ...NeedsRemediation.args,
    actions: { onFixCi: fn(), onResolveConflicts: fn(), fixBusy: true },
  },
};

/** The outside-Tauri sentinel: the command resolved `null`. */
export const Unavailable: Story = {
  args: { override: null },
};
