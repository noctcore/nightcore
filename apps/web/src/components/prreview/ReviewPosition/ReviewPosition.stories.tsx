import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { ReviewPosition } from './ReviewPosition';

const meta = {
  title: 'PrReview/ReviewPosition',
  component: ReviewPosition,
  decorators: [
    (Story) => (
      <div className="w-[720px] p-5">
        <Story />
      </div>
    ),
  ],
  args: {
    verdict: null,
    verdictReasoning: null,
    reconciliation: [],
    stale: false,
    followup: null,
    onReReview: fn(),
  },
} satisfies Meta<typeof ReviewPosition>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A ready-to-merge verdict with a collapsible justification. */
export const ReadyVerdict: Story = {
  args: {
    verdict: 'ready',
    verdictReasoning:
      'The diff is small, well-tested, and touches no security-sensitive path. Two low findings are style nits.',
  },
};

/** A blocking verdict (destructive tone). */
export const BlockedVerdict: Story = {
  args: {
    verdict: 'blocked',
    verdictReasoning: 'A critical auth bypass in the token-refresh path must be fixed first.',
  },
};

/** A posted approval now contradicted by the live PR status. */
export const Reconciliation: Story = {
  args: {
    verdict: 'ready',
    reconciliation: ['2 checks failing', 'Branch is behind the base'],
  },
};

/** The branch moved since the review — the staleness chip + re-review nudge. */
export const Stale: Story = {
  args: { verdict: 'merge_with_changes', stale: true },
};

/** A follow-up review's resolved / still-open / new summary. */
export const Followup: Story = {
  args: {
    verdict: 'needs_revision',
    followup: {
      resolved: 4,
      stillOpen: 2,
      added: 1,
      recurringFingerprints: new Set(['fp-a', 'fp-b']),
    },
  },
};

/** Everything at once: stale + contradicted + a follow-up delta. */
export const Combined: Story = {
  args: {
    verdict: 'merge_with_changes',
    verdictReasoning: 'Mergeable once the two remaining logic findings are addressed.',
    reconciliation: ['1 check failing'],
    stale: true,
    followup: {
      resolved: 3,
      stillOpen: 2,
      added: 0,
      recurringFingerprints: new Set(['fp-a', 'fp-b']),
    },
  },
};

/** Nothing to show — the component renders empty. */
export const Empty: Story = {};
