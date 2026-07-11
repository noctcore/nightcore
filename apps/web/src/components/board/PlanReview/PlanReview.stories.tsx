import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { makeTask, makeTaskActions } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { PlanReview } from './PlanReview';
import type { PlanReviewProps } from './PlanReview.types';

const SAMPLE_PLAN = `## Plan

1. Add the \`planGateDefault\` setting.
2. Wire the default-on resolution at submit.
3. Render the plan for review.`;

/** The story fixture: the panel wrapped in the `TaskActionsProvider` it reads
 *  Approve / Refine / Reject from. The handlers stay story ARGS so plays and tests
 *  keep overriding them per render (mirrors ReviewPanel). */
function PlanReviewFixture({
  onApprove,
  onRefine,
  onReject,
  ...props
}: PlanReviewProps & {
  onApprove?: (id: string) => void;
  onRefine?: (id: string, feedback: string) => void;
  onReject?: (id: string) => void;
}) {
  return (
    <TaskActionsProvider actions={makeTaskActions({ onApprove, onRefine, onReject })}>
      <PlanReview {...props} />
    </TaskActionsProvider>
  );
}

const meta = {
  title: 'Board/PlanReview',
  component: PlanReviewFixture,
  args: {
    onApprove: fn(),
    onRefine: fn(),
    onReject: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 440, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PlanReviewFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A plan parked for approval: the plan artifact, the refine-feedback field, and the
 *  Approve / Refine / Reject controls. */
export const Parked: Story = {
  args: {
    task: makeTask({
      id: 't-plan',
      status: 'waiting_approval',
      title: 'Add the plan-approval gate',
      plan: SAMPLE_PLAN,
    }),
  },
};

/** Play: Approve fires onApprove(id). */
export const ApprovesPlan: Story = {
  args: {
    task: makeTask({ id: 't-plan', status: 'waiting_approval', plan: SAMPLE_PLAN }),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /approve/i }));
    await expect(args.onApprove).toHaveBeenCalledWith('t-plan');
  },
};

/** Play: typing feedback then Refine relays it (same-session refinement prompt). */
export const RefinesWithFeedback: Story = {
  args: {
    task: makeTask({ id: 't-plan', status: 'waiting_approval', plan: SAMPLE_PLAN }),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Refine feedback'), 'use a worker pool');
    await userEvent.click(canvas.getByRole('button', { name: /refine/i }));
    await expect(args.onRefine).toHaveBeenCalledWith('t-plan', 'use a worker pool');
  },
};
