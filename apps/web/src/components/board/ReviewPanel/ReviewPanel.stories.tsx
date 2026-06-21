import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ReviewPanel } from './ReviewPanel';
import { SAMPLE_REVIEW_CHANGES, SAMPLE_REVIEW_PASS, makeTask } from '../_fixtures';

const meta = {
  title: 'Board/ReviewPanel',
  component: ReviewPanel,
  args: {
    onAccept: fn(),
    onReject: fn(),
    onRerun: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: 440, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ReviewPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A parked verification with a CHANGES_REQUESTED verdict and exhausted budget —
 *  the Accept / Rerun / Reject controls are live. */
export const ParkedChangesRequested: Story = {
  args: {
    task: makeTask({
      id: 't-waiting',
      status: 'waiting_approval',
      title: 'Apply destructive migration',
      review: SAMPLE_REVIEW_CHANGES,
      fixAttempts: 2,
    }),
  },
};

/** A passed verification on a verified task — verdict shown, no actions. */
export const Passed: Story = {
  args: {
    task: makeTask({
      id: 't-done',
      status: 'done',
      title: 'Wire up auth guard',
      review: SAMPLE_REVIEW_PASS,
      verified: true,
    }),
  },
};

/** A reviewer result with no machine-readable verdict — surfaced as fail-safe. */
export const Unparseable: Story = {
  args: {
    task: makeTask({
      id: 't-unparseable',
      status: 'waiting_approval',
      review: 'The reviewer crashed before emitting a verdict line.',
    }),
  },
};

/** Play test: Accept on a parked verification fires onAccept(id). */
export const AcceptsReview: Story = {
  args: {
    task: makeTask({
      id: 't-waiting',
      status: 'waiting_approval',
      review: SAMPLE_REVIEW_CHANGES,
    }),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /accept/i }));
    await expect(args.onAccept).toHaveBeenCalledWith('t-waiting');
  },
};

/** Play test: Rerun re-dispatches the reviewer. */
export const RerunsVerification: Story = {
  args: {
    task: makeTask({
      id: 't-waiting',
      status: 'waiting_approval',
      review: SAMPLE_REVIEW_CHANGES,
    }),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /rerun/i }));
    await expect(args.onRerun).toHaveBeenCalledWith('t-waiting');
  },
};
