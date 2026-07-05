import type { Meta, StoryObj } from '@storybook/react-vite';

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

/** The outside-Tauri sentinel: the command resolved `null`. */
export const Unavailable: Story = {
  args: { override: null },
};
