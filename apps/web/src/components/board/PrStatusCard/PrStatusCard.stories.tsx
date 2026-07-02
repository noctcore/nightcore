import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { makePrStatus, makeTask } from '../_fixtures';
import { PrStatusCard } from './PrStatusCard';

/** The canonical PR'd task: done + verified + committed worktree task whose PR
 *  exists but is not yet merged locally. */
const PR_TASK = makeTask({
  id: 't-pr',
  status: 'done',
  title: 'Wire up auth guard',
  branch: 'nc/auth-guard',
  runMode: 'worktree',
  verified: true,
  committed: true,
  prUrl: 'https://github.com/acme/nightcore/pull/123',
  prNumber: 123,
});

const meta = {
  title: 'Board/PrStatusCard',
  component: PrStatusCard,
  args: {
    task: PR_TASK,
    onOpenPr: fn(),
    onPushUpdates: fn(async () => {}),
    onFinalize: fn(async () => {}),
    onPullBase: fn(async () => {}),
    // Deterministic status via the override seam — stories never fetch.
    statusOverride: makePrStatus(),
  },
  decorators: [
    (Story) => (
      <div style={{ width: '26rem', padding: '1rem' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PrStatusCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A clean open PR with no review decision and no check runs (the checks line
 *  hides when every count is zero). */
export const OpenClean: Story = {};

/** Draft wins over Open when `isDraft` — a draft PR still reports state OPEN. */
export const DraftPr: Story = {
  args: { statusOverride: makePrStatus({ isDraft: true, mergeStateStatus: 'DRAFT' }) },
};

/** Checks in flight + review still required. */
export const ChecksRunning: Story = {
  args: {
    statusOverride: makePrStatus({
      reviewDecision: 'REVIEW_REQUIRED',
      checksPassed: 3,
      checksFailed: 1,
      checksPending: 2,
      mergeStateStatus: 'BLOCKED',
    }),
  },
};

/** Changes requested + conflicting with the base branch. */
export const ChangesRequested: Story = {
  args: {
    statusOverride: makePrStatus({
      reviewDecision: 'CHANGES_REQUESTED',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
    }),
  },
};

/** Approved but the branch has fallen behind the base. */
export const ApprovedBehindBase: Story = {
  args: {
    statusOverride: makePrStatus({
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'BEHIND',
    }),
  },
};

/** Local commits the PR lacks — the Push updates action appears with the count. */
export const UnpushedCommits: Story = {
  args: { statusOverride: makePrStatus({ unpushedCommits: 2 }) },
};

/** Remote-merged, not yet finalized locally — the Finalize gate shows. */
export const MergedAwaitingFinalize: Story = {
  args: {
    statusOverride: makePrStatus({ state: 'MERGED', reviewDecision: 'APPROVED' }),
  },
};

/** Finalized (task.merged) — the fast-forward base update offer replaces it. */
export const MergedFinalized: Story = {
  args: {
    task: makeTask({ ...PR_TASK, merged: true }),
    statusOverride: makePrStatus({ state: 'MERGED', reviewDecision: 'APPROVED' }),
  },
};

/** Unknown gh vocabulary degrades to the raw strings — never a crash or a lie. */
export const UnknownVocabulary: Story = {
  args: {
    statusOverride: makePrStatus({
      state: 'SUPERSEDED',
      reviewDecision: 'ESCALATED',
    }),
  },
};

/** The browser-preview degrade: no Tauri, no status — a quiet unavailable note. */
export const BrowserPreviewUnavailable: Story = {
  args: { statusOverride: null },
};

/** Play test: Push updates is confirm-gated — the dialog names the branch and
 *  count, and the handler only fires from its confirm. */
export const PushUpdatesConfirmGate: Story = {
  args: { statusOverride: makePrStatus({ unpushedCommits: 2 }) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Push updates (2)' }));
    await expect(args.onPushUpdates).not.toHaveBeenCalled();
    // The dialog's confirm button carries the exact label (no count suffix).
    await userEvent.click(canvas.getByRole('button', { name: 'Push updates' }));
    await expect(args.onPushUpdates).toHaveBeenCalledWith('t-pr');
  },
};
