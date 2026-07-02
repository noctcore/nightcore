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
import { canCreatePr, canMerge, deriveTaskDetailView, prChipLabel } from './TaskDetail.hooks';
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
  ReadyForPr,
  PrSupportRed,
  PrCreated,
  PrStatusTracked,
  PrCommentsTracked,
  PrRemoteMerged,
  PrFinalized,
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

test('disables Merge with an explanatory title when the PR is merged on GitHub', async () => {
  // PrRemoteMerged: committed + verified + passing gauntlet (locally Merge
  // would be armed) but the freshly-fetched PR state is MERGED — the branch
  // was integrated remotely, so the local Merge must point at Finalize.
  const screen = render(<PrRemoteMerged />);
  const merge = screen.getByRole('button', { name: /^merge$/i });
  await expect.element(merge).toBeDisabled();
  await expect
    .element(merge)
    .toHaveAttribute('title', 'Merged on GitHub — use Finalize');
});

test('an OPEN PR keeps local Merge armed (the disable keys on MERGED)', async () => {
  // Same task fixture as the remote-merged case, but the PR is OPEN: local
  // merge stays available (offline-capable, by design).
  const screen = render(<PrStatusTracked />);
  await expect.element(screen.getByRole('button', { name: /^merge$/i })).toBeEnabled();
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

test('shows Create PR beside Merge for an eligible task with a green probe', async () => {
  const onCreatePr = vi.fn();
  const screen = render(
    <ReadyForPr actions={{ ...ReadyForPr.args!.actions!, onCreatePr }} />,
  );
  await expect.element(screen.getByRole('button', { name: /^merge$/i })).toBeInTheDocument();
  const create = screen.getByRole('button', { name: /create pr/i });
  await expect.element(create).toBeEnabled();
  await create.click();
  expect(onCreatePr).toHaveBeenCalledWith('t-done');
});

test('hides Create PR when the capability probe is red', async () => {
  const screen = render(<PrSupportRed />);
  await expect.element(screen.getByRole('button', { name: /^merge$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /create pr/i }).query()).toBeNull();
});

test('hides Create PR while the probe is unknown (Done keeps only Merge)', async () => {
  const screen = render(<Done />);
  await expect.element(screen.getByRole('button', { name: /^merge$/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /create pr/i }).query()).toBeNull();
});

test('swaps the button for a PR #<n> chip once prUrl is set, linking out', async () => {
  const onOpenPr = vi.fn();
  const screen = render(<PrCreated actions={{ ...PrCreated.args!.actions!, onOpenPr }} />);
  expect(screen.getByRole('button', { name: /create pr/i }).query()).toBeNull();
  const chip = screen.getByRole('button', { name: /PR #123/ });
  await chip.click();
  expect(onOpenPr).toHaveBeenCalledWith('https://github.com/acme/nightcore/pull/123');
});

test('canCreatePr enforces the full eligibility contract', () => {
  const green = { ghInstalled: true, hasRemote: true };
  const eligible = makeTask({
    status: 'done',
    verified: true,
    committed: true,
    runMode: 'worktree',
    branch: 'nc/x',
  });
  expect(canCreatePr(eligible, green)).toBe(true);
  // Task-side gates: each broken precondition hides the button.
  expect(canCreatePr(makeTask({ ...eligible, status: 'ready' }), green)).toBe(false);
  expect(canCreatePr(makeTask({ ...eligible, verified: false }), green)).toBe(false);
  expect(canCreatePr(makeTask({ ...eligible, committed: false }), green)).toBe(false);
  expect(canCreatePr(makeTask({ ...eligible, runMode: 'main' }), green)).toBe(false);
  expect(canCreatePr(makeTask({ ...eligible, merged: true }), green)).toBe(false);
  expect(canCreatePr(makeTask({ ...eligible, prUrl: 'https://x/pr/1' }), green)).toBe(false);
  // Capability gates: unknown probe, missing gh, and missing remote all hide it.
  expect(canCreatePr(eligible, null)).toBe(false);
  expect(canCreatePr(eligible, undefined)).toBe(false);
  expect(canCreatePr(eligible, { ghInstalled: false, hasRemote: true })).toBe(false);
  expect(canCreatePr(eligible, { ghInstalled: true, hasRemote: false })).toBe(false);
});

test('prChipLabel folds in the PR number when present', () => {
  expect(prChipLabel(makeTask({ prNumber: 123 }))).toBe('PR #123');
  expect(prChipLabel(makeTask({}))).toBe('PR');
});

test('mounts the PR status card once prUrl is set', async () => {
  // No prStatus override: the card fetches on mount, and outside Tauri the
  // bridge resolves its null sentinel — the quiet unavailable note.
  const screen = render(<PrCreated />);
  await expect.element(screen.getByText('Pull request')).toBeInTheDocument();
  // The Review comments section below adds its own Refresh — scope to the first
  // (the PR status card's, which renders above it).
  await expect
    .element(screen.getByRole('button', { name: /refresh/i }).first())
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/PR status is unavailable in the browser preview/))
    .toBeInTheDocument();
});

test('no PR band renders before a PR exists', async () => {
  const screen = render(<Done />);
  await expect.element(screen.getByText('Overview')).toBeInTheDocument();
  expect(screen.getByText('Pull request').query()).toBeNull();
});

test('mounts the Review comments section once prUrl is set', async () => {
  // No prReviewComments override: the section fetches on mount, and outside
  // Tauri the bridge resolves its empty payload — the quiet empty note.
  const screen = render(<PrCreated />);
  // Anchored so the label span doesn't collide with the "No unresolved review
  // comments." note below (a substring match otherwise resolves to two nodes).
  await expect.element(screen.getByText(/^Review comments$/)).toBeInTheDocument();
  await expect
    .element(screen.getByText('No unresolved review comments.'))
    .toBeInTheDocument();
});

test('no Review comments section renders before a PR exists', async () => {
  const screen = render(<Done />);
  await expect.element(screen.getByText('Overview')).toBeInTheDocument();
  expect(screen.getByText(/^Review comments$/).query()).toBeNull();
});

test('the Review comments section fires onAddressPrComments through its confirm', async () => {
  const onAddressPrComments = vi.fn(async () => {});
  const screen = render(
    <PrCommentsTracked
      actions={{ ...PrCommentsTracked.args!.actions!, onAddressPrComments }}
    />,
  );
  // The injected payload carries unresolved comments — Address is armed.
  await screen.getByRole('button', { name: 'Address comments' }).click();
  // Human gate: nothing fires until the dialog confirm (dialog-scoped — the
  // card button's name matches the confirm's).
  expect(onAddressPrComments).not.toHaveBeenCalled();
  await screen
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Address comments' })
    .click();
  await vi.waitFor(() => expect(onAddressPrComments).toHaveBeenCalledWith('t-done'));
});

test('the card offers Push updates for an open PR with unpushed commits and confirms through the dialog', async () => {
  const onPushPrUpdates = vi.fn(async () => {});
  const screen = render(
    <PrStatusTracked
      actions={{ ...PrStatusTracked.args!.actions!, onPushPrUpdates }}
    />,
  );
  await expect.element(screen.getByText('Approved')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'Push updates (2)' }).click();
  // Human gate: nothing fires until the dialog confirm (dialog-scoped — the
  // card button's name contains the confirm's).
  expect(onPushPrUpdates).not.toHaveBeenCalled();
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Push updates' }).click();
  await vi.waitFor(() => expect(onPushPrUpdates).toHaveBeenCalledWith('t-done'));
});

test('a remote-merged PR offers Finalize until the local task flips merged', async () => {
  const onFinalizePr = vi.fn(async () => {});
  const screen = render(
    <PrRemoteMerged actions={{ ...PrRemoteMerged.args!.actions!, onFinalizePr }} />,
  );
  await expect.element(screen.getByText('Merged')).toBeInTheDocument();
  await screen.getByRole('button', { name: /finalize/i }).click();
  // The card button and dialog confirm share the label — scope to the dialog.
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Finalize' }).click();
  await vi.waitFor(() => expect(onFinalizePr).toHaveBeenCalledWith('t-done'));
});

test('a finalized task swaps Finalize for the base fast-forward offer', async () => {
  const onPullBaseFf = vi.fn(async () => {});
  const screen = render(
    <PrFinalized actions={{ ...PrFinalized.args!.actions!, onPullBaseFf }} />,
  );
  // The footer shows the existing Merged terminal state (the echo flipped it).
  await expect.element(screen.getByRole('button', { name: /^merged$/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /finalize/i }).query()).toBeNull();
  await screen.getByRole('button', { name: 'Update base branch' }).click();
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Update base' }).click();
  await vi.waitFor(() => expect(onPullBaseFf).toHaveBeenCalledWith('t-done'));
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
