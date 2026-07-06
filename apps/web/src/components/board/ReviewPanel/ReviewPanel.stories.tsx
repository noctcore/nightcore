import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import {
  makeTask,
  makeTaskActions,
  SAMPLE_REVIEW_CHANGES,
  SAMPLE_REVIEW_PASS,
  STRUCTURE_LOCK_FAILED,
} from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { ReviewPanel } from './ReviewPanel';
import type { ReviewPanelProps } from './ReviewPanel.types';

/** The story fixture: the panel wrapped in the `TaskActionsProvider` it now reads
 *  Accept / Reject / Rerun from. The handlers stay story ARGS so plays and tests
 *  keep overriding them per render. */
function ReviewPanelFixture({
  onAccept,
  onReject,
  onRerun,
  ...props
}: ReviewPanelProps & {
  onAccept?: (id: string) => void;
  onReject?: (id: string) => void;
  onRerun?: (id: string) => void;
}) {
  return (
    <TaskActionsProvider
      actions={makeTaskActions({
        onAcceptReview: onAccept,
        onRejectReview: onReject,
        onRerunVerification: onRerun,
      })}
    >
      <ReviewPanel {...props} />
    </TaskActionsProvider>
  );
}

const meta = {
  title: 'Board/ReviewPanel',
  component: ReviewPanelFixture,
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
} satisfies Meta<typeof ReviewPanelFixture>;

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

/** A task parked by a failed Structure-Lock Gauntlet before any reviewer ran — the
 *  destructive alert names the failed harness check (no reviewer verdict yet). */
export const StructureLockParked: Story = {
  args: {
    task: makeTask({
      id: 't-locked',
      status: 'waiting_approval',
      title: 'Refactor the board feature',
      review: null,
      structureLockResult: STRUCTURE_LOCK_FAILED,
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
