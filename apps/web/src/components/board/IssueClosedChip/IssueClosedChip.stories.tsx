import type { Meta, StoryObj } from '@storybook/react-vite';

import { makeTask } from '../_fixtures.task';
import { IssueClosedChip } from './IssueClosedChip';

const meta = {
  title: 'Board/IssueClosedChip',
  component: IssueClosedChip,
} satisfies Meta<typeof IssueClosedChip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A running task whose linked issue #128 was closed on GitHub — the chip shows. */
export const ClosedUpstream: Story = {
  args: {
    task: makeTask({ status: 'in_progress', issueNumber: 128, issueState: 'closed' }),
  },
};

/** The linked issue is still open — the chip renders nothing. */
export const IssueOpen: Story = {
  args: {
    task: makeTask({ status: 'in_progress', issueNumber: 128, issueState: 'open' }),
  },
};

/** The task is already Done — a closed issue is the expected outcome, so no chip. */
export const TaskDone: Story = {
  args: {
    task: makeTask({ status: 'done', issueNumber: 128, issueState: 'closed' }),
  },
};
