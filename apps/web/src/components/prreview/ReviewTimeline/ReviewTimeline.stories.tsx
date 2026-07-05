import type { Meta, StoryObj } from '@storybook/react-vite';

import type { TimelineStep } from '../prreview-lifecycle';
import { ReviewTimeline } from './ReviewTimeline';

const NOW = Date.parse('2026-07-05T12:00:00Z');

const REVIEWED_PENDING: TimelineStep[] = [
  { id: 'review', label: 'Reviewed', state: 'done', at: NOW - 3_600_000 },
  { id: 'posted', label: 'Pending post', state: 'upcoming', at: null },
];

const FULL_ARC: TimelineStep[] = [
  { id: 'review', label: 'Reviewed', state: 'done', at: NOW - 7_200_000 },
  { id: 'posted', label: 'Posted to GitHub', state: 'done', at: NOW - 6_000_000 },
  { id: 'fix', label: 'Fix pushed', state: 'done', at: NOW - 1_800_000 },
  { id: 're-review', label: 'Re-review — branch moved', state: 'upcoming', at: null },
];

const FIXING: TimelineStep[] = [
  { id: 'review', label: 'Reviewed', state: 'done', at: NOW - 5_400_000 },
  { id: 'posted', label: 'Posted to GitHub', state: 'done', at: NOW - 4_800_000 },
  { id: 'fix', label: 'Fix running', state: 'current', at: NOW - 120_000 },
];

const meta = {
  title: 'PrReview/ReviewTimeline',
  component: ReviewTimeline,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
  args: { steps: REVIEWED_PENDING },
} satisfies Meta<typeof ReviewTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReviewedPendingPost: Story = {};
export const FullArc: Story = { args: { steps: FULL_ARC } };
export const FixRunning: Story = { args: { steps: FIXING } };

/** A lone node (a live review) has no arc — the stepper self-hides. */
export const SingleNodeHidden: Story = {
  args: { steps: [{ id: 'review', label: 'Reviewing', state: 'current', at: NOW }] },
};
