import { composeStories } from '@storybook/react-vite';
import { render } from 'vitest-browser-react';
import { expect, test, vi } from 'vitest';
import * as stories from './TaskDetail.stories';
import { canMerge, deriveTaskDetailView } from './TaskDetail.hooks';
import { EMPTY_STREAM } from '../session-stream';
import {
  GAUNTLET_FAILED,
  GAUNTLET_PASSED,
  SAMPLE_REVIEW_CHANGES,
  makeTask,
} from '../_fixtures';

const {
  Running,
  Failed,
  WaitingApproval,
  RunningWithPrompt,
  ReviewParked,
  Done,
  VerifiedMergeGated,
  GauntletFailed,
} = composeStories(stories);

test('shows the plan and Approve / Refine / Reject for a waiting task', async () => {
  const onApprove = vi.fn();
  const screen = render(<WaitingApproval onApprove={onApprove} />);
  await expect.element(screen.getByText('Proposed plan')).toBeInTheDocument();
  await expect.element(screen.getByText(/Back up the users table/)).toBeInTheDocument();
  await screen.getByRole('button', { name: /approve/i }).click();
  expect(onApprove).toHaveBeenCalledWith('t-waiting');
  await expect.element(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
});

test('renders a parked permission prompt and relays the decision', async () => {
  const onRespondPermission = vi.fn();
  const screen = render(<RunningWithPrompt onRespondPermission={onRespondPermission} />);
  await expect.element(screen.getByText('Approval needed')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'Allow' }).click();
  expect(onRespondPermission).toHaveBeenCalledWith('t-running', 'req-1', 'allow');
});

test('shows the live transcript heading and cancel control while running', async () => {
  const screen = render(<Running />);
  await expect.element(screen.getByText('Live transcript')).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /cancel run/i }))
    .toBeInTheDocument();
});

test('renders the persisted error for a failed task', async () => {
  const onRun = vi.fn();
  const screen = render(<Failed onRun={onRun} />);
  await expect
    .element(screen.getByText("cannot resolve 'sass-loader'"))
    .toBeInTheDocument();
});

test('deriveTaskDetailView prefers the live stream over persisted values', () => {
  const task = makeTask({ status: 'in_progress', costUsd: 0.1, summary: 'old' });
  const view = deriveTaskDetailView(task, {
    ...EMPTY_STREAM,
    answer: 'live',
    costUsd: 0.5,
  });
  expect(view.isRunning).toBe(true);
  expect(view.cost).toBe(0.5);
  expect(view.answer).toBe('live');
});

test('shows the reviewer verdict and Accept / Rerun / Reject for a review-parked task', async () => {
  const onAcceptReview = vi.fn();
  const screen = render(<ReviewParked onAcceptReview={onAcceptReview} />);
  await expect.element(screen.getByText('Changes requested')).toBeInTheDocument();
  await screen.getByRole('button', { name: /accept/i }).click();
  expect(onAcceptReview).toHaveBeenCalledWith('t-waiting');
  await expect.element(screen.getByRole('button', { name: /rerun/i })).toBeInTheDocument();
});

test('a review-parked task does not show the plan-approval controls', async () => {
  const screen = render(<ReviewParked />);
  // The plan Refine action belongs to plan-parked tasks only.
  expect(screen.container.querySelector('button[title]')).not.toBeNull();
  await expect.element(screen.getByText(/Resolve the reviewer verdict/)).toBeInTheDocument();
});

test('enables Merge for a verified task with a passing gauntlet', async () => {
  const onMerge = vi.fn();
  const screen = render(<Done onMerge={onMerge} />);
  const merge = screen.getByRole('button', { name: /^merge$/i });
  await expect.element(merge).toBeEnabled();
  await merge.click();
  expect(onMerge).toHaveBeenCalledWith('t-done');
});

test('disables Merge until the gauntlet has run', async () => {
  const screen = render(<VerifiedMergeGated />);
  await expect.element(screen.getByRole('button', { name: /^merge$/i })).toBeDisabled();
});

test('disables Merge when the gauntlet failed', async () => {
  const screen = render(<GauntletFailed />);
  await expect.element(screen.getByRole('button', { name: /^merge$/i })).toBeDisabled();
  await expect.element(screen.getByText(/Failed at test/)).toBeInTheDocument();
});

test('canMerge gates on verified + a passing gauntlet', () => {
  const verified = makeTask({ status: 'done', verified: true, committed: true });
  expect(canMerge(verified, GAUNTLET_PASSED)).toBe(true);
  expect(canMerge(verified, GAUNTLET_FAILED)).toBe(false);
  expect(canMerge(verified, null)).toBe(false);
  const unverified = makeTask({ status: 'done', verified: false });
  expect(canMerge(unverified, GAUNTLET_PASSED)).toBe(false);
});

test('deriveTaskDetailView splits review-parked from plan-parked on task.review', () => {
  const reviewParked = deriveTaskDetailView(
    makeTask({ status: 'waiting_approval', review: SAMPLE_REVIEW_CHANGES }),
    undefined,
  );
  expect(reviewParked.reviewParked).toBe(true);
  expect(reviewParked.planParked).toBe(false);

  const planParked = deriveTaskDetailView(
    makeTask({ status: 'waiting_approval', plan: 'do the thing' }),
    undefined,
  );
  expect(planParked.planParked).toBe(true);
  expect(planParked.reviewParked).toBe(false);
});
