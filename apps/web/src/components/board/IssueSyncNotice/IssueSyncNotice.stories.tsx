import type { Meta, StoryObj } from '@storybook/react-vite';

import { makeTask } from '../_fixtures.task';
import { IssueSyncNotice } from './IssueSyncNotice';

const meta = {
  title: 'Board/IssueSyncNotice',
  component: IssueSyncNotice,
} satisfies Meta<typeof IssueSyncNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Comments-only downgrade — the token can post comments but not manage labels. */
export const CommentsOnly: Story = {
  args: {
    task: makeTask({
      issueNumber: 42,
      issueSyncError: 'Issue sync running comments-only: the token can’t manage labels on this repo.',
    }),
  },
};

/** Silent-off — the token lacks issue-write access entirely; writeback is paused. */
export const SilentOff: Story = {
  args: {
    task: makeTask({
      issueNumber: 42,
      issueSyncError: 'Issue sync paused: the token lacks write access to this repo.',
    }),
  },
};

/** Healthy — no degradation reason, so the notice renders nothing. */
export const Healthy: Story = {
  args: { task: makeTask({ issueNumber: 42 }) },
};
