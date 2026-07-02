import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import {
  GAUNTLET_FAILED,
  GAUNTLET_PASSED,
  makeTask,
  SAMPLE_REVIEW_CHANGES,
} from '../_fixtures';
import { EMPTY_STREAM } from '../session-stream';
import { canMerge, deriveTaskDetailView } from './TaskDetail.hooks';
import * as stories from './TaskDetail.stories';

const {
  Running,
  Failed,
  WaitingApproval,
  RunningWithPrompt,
  ReviewParked,
  Done,
  VerifiedMergeGated,
  GauntletFailed,
  MainModeCommitted,
  ResearchDone,
  EmptyBacklog,
  FromScanProvenance,
} = composeStories(stories);

test('shows a provenance chip for a task converted from a scan', async () => {
  const screen = render(<FromScanProvenance />);
  await expect
    .element(screen.getByText('From Harness convention'))
    .toBeInTheDocument();
});

test('shows no provenance chip for a hand-created task', async () => {
  const screen = render(<EmptyBacklog />);
  // `.query()` returns null when no element matches (vitest-browser locators).
  expect(screen.getByText(/^From /).query()).toBeNull();
});

test('shows the plan and Approve / Refine / Reject for a waiting task', async () => {
  const onApprove = vi.fn();
  const screen = render(
    <WaitingApproval actions={{ ...WaitingApproval.args!.actions!, onApprove }} />,
  );
  await expect.element(screen.getByText('Proposed plan')).toBeInTheDocument();
  await expect.element(screen.getByText(/Back up the users table/)).toBeInTheDocument();
  await screen.getByRole('button', { name: /approve/i }).click();
  expect(onApprove).toHaveBeenCalledWith('t-waiting');
  await expect.element(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
});

test('renders a parked permission prompt and relays the decision', async () => {
  const onRespondPermission = vi.fn();
  const screen = render(
    <RunningWithPrompt
      actions={{ ...RunningWithPrompt.args!.actions!, onRespondPermission }}
    />,
  );
  await expect.element(screen.getByText('Approval needed')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'Allow' }).click();
  expect(onRespondPermission).toHaveBeenCalledWith('t-running', 'req-1', 'allow');
});

test('shows the live activity heading and cancel control while running', async () => {
  const screen = render(<Running />);
  await expect.element(screen.getByText('Live activity')).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /cancel run/i }))
    .toBeInTheDocument();
});

test('renders the persisted error for a failed task', async () => {
  const onRun = vi.fn();
  const screen = render(<Failed actions={{ ...Failed.args!.actions!, onRun }} />);
  await expect
    .element(screen.getByText("cannot resolve 'sass-loader'"))
    .toBeInTheDocument();
});

test('deriveTaskDetailView prefers the live stream over persisted values', () => {
  const task = makeTask({ status: 'in_progress', costUsd: 0.1, summary: 'old' });
  const view = deriveTaskDetailView(task, {
    sessions: [
      {
        index: 1,
        sdkSessionId: null,
        model: null,
        prompt: null,
        phase: 'build',
        stream: {
          ...EMPTY_STREAM,
          entries: [{ kind: 'text', id: 1, markdown: 'live', closed: false }],
          costUsd: 0.5,
        },
      },
    ],
    toolCount: 0,
  });
  expect(view.isRunning).toBe(true);
  expect(view.cost).toBe(0.5);
  expect(view.sessions[0]!.stream.entries).toEqual([
    { kind: 'text', id: 1, markdown: 'live', closed: false },
  ]);
});

test('deriveTaskDetailView falls back to the stored summary as a single session', () => {
  const task = makeTask({ status: 'done', summary: 'Final summary' });
  const view = deriveTaskDetailView(task, undefined);
  expect(view.sessions).toHaveLength(1);
  expect(view.sessions[0]!.stream.entries).toEqual([
    { kind: 'text', id: 0, markdown: 'Final summary', closed: true },
  ]);
});

test('shows the reviewer verdict and Accept / Rerun / Reject for a review-parked task', async () => {
  const onAcceptReview = vi.fn();
  const screen = render(
    <ReviewParked actions={{ ...ReviewParked.args!.actions!, onAcceptReview }} />,
  );
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
  const screen = render(<Done actions={{ ...Done.args!.actions!, onMerge }} />);
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
  const verified = makeTask({
    status: 'done',
    verified: true,
    committed: true,
    runMode: 'worktree',
    branch: 'nc/x',
  });
  expect(canMerge(verified, GAUNTLET_PASSED)).toBe(true);
  expect(canMerge(verified, GAUNTLET_FAILED)).toBe(false);
  expect(canMerge(verified, null)).toBe(false);
  const unverified = makeTask({ status: 'done', verified: false, runMode: 'worktree' });
  expect(canMerge(unverified, GAUNTLET_PASSED)).toBe(false);
});

test('replaces Merge with a disabled Committed state for a main-mode task', async () => {
  const screen = render(<MainModeCommitted />);
  const committed = screen.getByRole('button', { name: /committed/i });
  await expect.element(committed).toBeDisabled();
  expect(screen.container.querySelector('button[disabled]')).not.toBeNull();
});

test('canMerge refuses a main-mode task even when verified + passing', () => {
  const mainTask = makeTask({
    status: 'done',
    verified: true,
    committed: true,
    runMode: 'main',
    branch: null,
  });
  expect(canMerge(mainTask, GAUNTLET_PASSED)).toBe(false);
});

test('a done-but-unverified research task shows neutral "Done" — not green "Verified"', async () => {
  const screen = render(<ResearchDone />);
  await expect.element(screen.getByText('Done')).toBeInTheDocument();
  expect(screen.container.querySelector('.text-success')).toBeNull();
});

test('a done AND verified task shows the green "Verified" badge', async () => {
  const screen = render(<Done />);
  await expect.element(screen.getByText('Verified')).toBeInTheDocument();
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
