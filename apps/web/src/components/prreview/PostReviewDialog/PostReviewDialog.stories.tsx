import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { PostReviewGate } from '../prreview.types';
import { PostReviewDialog } from './PostReviewDialog';

/** A gate armed on the pre-filled verdict of a `needs_revision` (clamped) run. */
const GATE: PostReviewGate = {
  postVerdict: 'request-changes',
  posting: false,
  postError: null,
  postPrNumber: 128,
  selectedCount: 9,
  selectedInlineCount: 3,
  selectedBodyCount: 6,
  postAllInline: false,
  setPostAllInline: fn(),
  recommendedVerdict: 'request-changes',
  clampReason:
    'model proposed "merge_with_changes" but the worst finding severity is "high", which floors the verdict at "needs_revision"',
  requestPost: fn(),
  confirmPost: fn(),
  cancelPost: fn(),
};

const meta = {
  title: 'PrReview/PostReviewDialog',
  component: PostReviewDialog,
  parameters: { layout: 'fullscreen' },
  args: { post: GATE },
} satisfies Meta<typeof PostReviewDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Armed on the PRE-FILLED verdict, with the clamp reason explaining it. */
export const PrefilledFromClamp: Story = {};

/** The human overrode the pre-fill — the copy names what was recommended. */
export const HumanOverrodeTheVerdict: Story = {
  args: { post: { ...GATE, postVerdict: 'comment' } },
};

/** A lows-only review: `merge_with_changes` pre-fills a non-blocking comment. */
export const LowsOnly: Story = {
  args: {
    post: {
      ...GATE,
      postVerdict: 'comment',
      recommendedVerdict: 'comment',
      clampReason: null,
      selectedInlineCount: 0,
      selectedBodyCount: 11,
      selectedCount: 11,
    },
  },
};

/** A failed post keeps the gate open with the error inline. */
export const PostFailed: Story = {
  args: { post: { ...GATE, postError: 'gh: HTTP 422 — anchor outside the diff' } },
};

/** Closed gate: nothing armed, nothing rendered. */
export const Closed: Story = { args: { post: { ...GATE, postVerdict: null } } };
