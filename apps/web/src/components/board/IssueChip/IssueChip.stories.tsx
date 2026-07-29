import type { Meta, StoryObj } from '@storybook/react-vite';

import { makeTask } from '../_fixtures.task';
import { IssueChip } from './IssueChip';

const meta = {
  title: 'Board/IssueChip',
  component: IssueChip,
} satisfies Meta<typeof IssueChip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A task converted from issue #402 — the chip links back to it (parity with `PR #N`). */
export const Linked: Story = {
  args: { task: makeTask({ issueNumber: 402 }) },
};

/** The issue is still open upstream — the chip is unchanged (it names provenance, not
 *  state). */
export const IssueOpenUpstream: Story = {
  args: { task: makeTask({ issueNumber: 402, issueState: 'open' }) },
};

/** A Done task keeps its provenance chip even after the issue closed upstream (there is
 *  no divergence to warn about once the work landed). */
export const DoneWithClosedIssue: Story = {
  args: { task: makeTask({ status: 'done', issueNumber: 402, issueState: 'closed' }) },
};

/** The issue was closed upstream while the task is still running — the louder
 *  `IssueClosedChip` owns that slot, so this chip yields and renders nothing. */
export const YieldsToClosedUpstreamChip: Story = {
  args: {
    task: makeTask({ status: 'in_progress', issueNumber: 402, issueState: 'closed' }),
  },
};

/** A hand-created task links no issue — nothing renders. */
export const NoLinkedIssue: Story = { args: { task: makeTask() } };
