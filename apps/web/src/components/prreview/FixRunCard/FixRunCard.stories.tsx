import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { PrFixState } from '@/lib/bridge';

import { FixRunCard } from './FixRunCard';

function fixState(over: Partial<PrFixState> = {}): PrFixState {
  return {
    id: 'prfix-1',
    kind: 'findings',
    runId: 'run-1',
    prNumber: 128,
    branch: 'fix/worktree-isolation',
    dir: '/repo/.nightcore/pr-fix/pr-128',
    status: 'running',
    summary: null,
    error: null,
    findingCount: 3,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

const meta = {
  title: 'PrReview/FixRunCard',
  component: FixRunCard,
  decorators: [
    (Story) => (
      <div className="w-[720px] p-5">
        <Story />
      </div>
    ),
  ],
  args: {
    fix: fixState(),
    pushing: false,
    onCancel: fn(),
    onRequestPush: fn(),
    onReReview: fn(),
    onDismiss: fn(),
    onTryAgain: fn(),
  },
} satisfies Meta<typeof FixRunCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {};

/** A ci-kind fix in flight — the running line names the failing checks. */
export const RunningCi: Story = {
  args: { fix: fixState({ kind: 'ci', runId: null, findingCount: 2 }) },
};

/** A conflicts-kind fix in flight — the running line names the conflicted files. */
export const RunningConflicts: Story = {
  args: { fix: fixState({ kind: 'conflicts', runId: null, findingCount: 4 }) },
};

/** The session finished and its commit is being written — the transient state
 *  between running and awaiting_push. No actions render. */
export const Committing: Story = {
  args: { fix: fixState({ status: 'committing' }) },
};

/** The session finished and auto-committed; the push is the human's call. The
 *  summary is model markdown — rendered through the SANITIZING Markdown
 *  primitive (bold/lists/inline code style like the PR description). */
export const AwaitingPush: Story = {
  args: {
    fix: fixState({
      status: 'awaiting_push',
      summary:
        'Fixed the token logging and the unchecked unwrap.\n\n- src/auth.ts: redact the session token\n- src/run.rs: **handle** the None case',
    }),
  },
};

/** A push is armed and in flight — the button shows busy. */
export const AwaitingPushBusy: Story = {
  args: {
    fix: fixState({ status: 'awaiting_push', summary: 'One-line fix.' }),
    pushing: true,
  },
};

export const Pushed: Story = {
  args: { fix: fixState({ status: 'pushed' }) },
};

export const Failed: Story = {
  args: {
    fix: fixState({
      status: 'failed',
      error: 'the PR head is on a fork — check it out manually to fix it',
    }),
  },
};

/** Cancelled fixes land as failed("cancelled"). */
export const Cancelled: Story = {
  args: { fix: fixState({ status: 'failed', error: 'cancelled' }) },
};
