import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { PermissionPrompt, QuestionPrompt } from '@/lib/bridge';

import {
  GAUNTLET_FAILED,
  GAUNTLET_PASSED,
  makeTask,
  makeTaskActions,
  SAMPLE_REVIEW_CHANGES,
} from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import {
  EMPTY_STREAM,
  type TaskTranscript,
  type TimelineEntry,
} from '../session-stream';
import { TaskDetail } from './TaskDetail';
import {
  canCreatePr,
  canMerge,
  createPrBlockedReason,
  deriveTaskDetailView,
  prChipLabel,
} from './TaskDetail.hooks';
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
  TrustBandTracked,
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

test('the provenance chip fires onOpenSourceRef with the raw token for each legacy scheme', async () => {
  // The mint PREFIXES are frozen and the chip label (sourceRefLabel) is unchanged
  // by the stage flip, so every legacy scheme still renders its chip and hands the
  // RAW token back to routing (which retargets it via the REGISTRY).
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['insight:run-1:f-9', 'Insight finding'],
    ['scorecard:run-2:r-3', 'Scorecard reading'],
    ['harness:run-4:conv-1', 'Harness convention'],
    ['harness-proposal:run-4:prop-2', 'Harness proposal'],
    ['pr-review:run-5:sf-1', 'PR Review finding'],
    ['issue-triage:val-7', 'Issue validation'],
  ];
  for (const [ref, label] of cases) {
    const onOpenSourceRef = vi.fn();
    const screen = render(
      <FromScanProvenance task={makeTask({ sourceRef: ref })} onOpenSourceRef={onOpenSourceRef} />,
    );
    await screen.getByRole('button', { name: new RegExp(`From ${label}`) }).click();
    expect(onOpenSourceRef).toHaveBeenCalledWith(ref);
  }
});

test('an unknown-scheme sourceRef renders no provenance chip (graceful degradation)', async () => {
  // A future/legacy scheme not in the REGISTRY degrades silently — no chip, and
  // routing no-ops if somehow invoked (see useRouting malformed-token test).
  const screen = render(<FromScanProvenance task={makeTask({ sourceRef: 'mystery:run:item' })} />);
  await expect.element(screen.getByText('Overview')).toBeInTheDocument();
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

test('shows a disabled Create PR with a gh-missing hint when the probe is red', async () => {
  // An eligible task with a RED probe no longer hides the button: it stays visible
  // but disabled, its tooltip naming the unmet capability (feature: eligibility is
  // self-explanatory instead of a silent vanish).
  const screen = render(<PrSupportRed />);
  const create = screen.getByRole('button', { name: /create pr/i });
  await expect.element(create).toBeDisabled();
  await expect
    .element(create)
    .toHaveAttribute('title', 'GitHub CLI (gh) is not installed — install it to open PRs.');
});

test('shows a disabled Create PR while the capability probe is loading', async () => {
  // A null (still-probing) capability shows the button disabled with a "checking"
  // hint rather than hiding it.
  const screen = render(<ReadyForPr prSupport={null} />);
  const create = screen.getByRole('button', { name: /create pr/i });
  await expect.element(create).toBeDisabled();
  await expect
    .element(create)
    .toHaveAttribute('title', 'Checking whether GitHub is available…');
});

test('shows a disabled Create PR with a verify hint for a committed-but-unverified task', async () => {
  // The dogfood blocker: a Done-column worktree task that is committed but stuck
  // un-verified used to show NO Create PR button at all. Now it shows the button
  // disabled, explaining that verification is the missing step.
  const screen = render(
    <ReadyForPr
      task={makeTask({
        id: 't-done',
        status: 'done',
        runMode: 'worktree',
        branch: 'nc/x',
        committed: true,
        verified: false,
      })}
      prSupport={{ ghInstalled: true, hasRemote: true }}
    />,
  );
  const create = screen.getByRole('button', { name: /create pr/i });
  await expect.element(create).toBeDisabled();
  await expect
    .element(create)
    .toHaveAttribute(
      'title',
      'Task is not verified yet — a reviewer must pass it before you can open a PR.',
    );
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

test('createPrBlockedReason names the first unmet condition, or null when N/A / eligible', () => {
  const green = { ghInstalled: true, hasRemote: true };
  const eligible = makeTask({
    status: 'done',
    verified: true,
    committed: true,
    runMode: 'worktree',
    branch: 'nc/x',
  });
  // Eligible ⇒ no blocking reason (the enabled button renders).
  expect(createPrBlockedReason(eligible, green)).toBeNull();
  // Not-applicable states ⇒ null (sibling controls own them), never a disabled PR button.
  expect(createPrBlockedReason(makeTask({ ...eligible, runMode: 'main', branch: null }), green)).toBeNull();
  expect(createPrBlockedReason(makeTask({ ...eligible, merged: true }), green)).toBeNull();
  expect(
    createPrBlockedReason(makeTask({ ...eligible, prUrl: 'https://x/pr/1' }), green),
  ).toBeNull();
  // Unmet conditions ⇒ the reason, in backend precondition order.
  expect(createPrBlockedReason(makeTask({ ...eligible, committed: false }), green)).toMatch(
    /Commit the task/,
  );
  expect(createPrBlockedReason(makeTask({ ...eligible, verified: false }), green)).toMatch(
    /not verified/,
  );
  expect(createPrBlockedReason(eligible, null)).toMatch(/Checking whether GitHub/);
  expect(
    createPrBlockedReason(eligible, { ghInstalled: false, hasRemote: true }),
  ).toMatch(/gh\) is not installed/);
  expect(
    createPrBlockedReason(eligible, { ghInstalled: true, hasRemote: false }),
  ).toMatch(/No git remote/);
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

test('TaskDetailChrome bails on a stream flush while the activity log updates', async () => {
  // The volatility contract behind the context split: a per-frame `nc:session`
  // flush hands TaskDetail a FRESH transcript object, which must re-render ONLY
  // the context-fed activity subtree — the memoized TaskDetailChrome (title,
  // config, footer) must bail. `isActionPending` is the probe: the chrome's
  // footer calls it during render (the Run button's pending checks), so a stable
  // call count across the flush proves the chrome did not re-render.
  const isActionPending = vi.fn(() => false);
  const task = makeTask({ id: 't-flush', status: 'backlog' });
  const actions = makeTaskActions();
  const onClose = () => {};
  // Stable empty prompt arrays — the shell passes stable fallbacks for exactly
  // this reason (a fresh `[]` per render would defeat the chrome memo itself).
  const noPrompts: PermissionPrompt[] = [];
  const noQuestions: QuestionPrompt[] = [];
  const transcriptOf = (entries: TimelineEntry[]): TaskTranscript => ({
    sessions: [
      {
        index: 1,
        sdkSessionId: null,
        model: null,
        prompt: null,
        phase: 'build',
        stream: { ...EMPTY_STREAM, entries },
      },
    ],
    toolCount: 0,
  });
  const drawer = (stream: TaskTranscript) => (
    <TaskActionsProvider actions={actions}>
      <TaskDetail
        task={task}
        stream={stream}
        anyRunning={false}
        prompts={noPrompts}
        questions={noQuestions}
        gauntlet={null}
        gauntletRunning={false}
        prSupport={null}
        onClose={onClose}
        isActionPending={isActionPending}
      />
    </TaskActionsProvider>
  );

  const screen = render(
    drawer(transcriptOf([{ kind: 'text', id: 1, markdown: 'first delta', closed: true }])),
  );
  await expect.element(screen.getByText('first delta')).toBeInTheDocument();
  const callsAfterMount = isActionPending.mock.calls.length;
  expect(callsAfterMount).toBeGreaterThan(0);

  // The flush: a brand-new transcript object carrying one more entry.
  screen.rerender(
    drawer(
      transcriptOf([
        { kind: 'text', id: 1, markdown: 'first delta', closed: true },
        { kind: 'text', id: 2, markdown: 'second delta', closed: false },
      ]),
    ),
  );
  // The activity subtree DID update through TaskStreamContext…
  await expect.element(screen.getByText('second delta')).toBeInTheDocument();
  // …while the chrome bailed: its footer probes never ran again.
  expect(isActionPending.mock.calls.length).toBe(callsAfterMount);
});

test('renders the Trust band beside the Result band for a task that has run', async () => {
  // The story passes the `trustReport` override (skipping the fetch) so the band
  // renders populated: the Trust GroupLabel, the pass summary, and the export
  // action all sit below the Result band's verdict.
  const screen = render(<TrustBandTracked />);
  await expect.element(screen.getByText('Result')).toBeInTheDocument();
  await expect.element(screen.getByText('Trust')).toBeInTheDocument();
  await expect.element(screen.getByText('✓ Verified')).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: /^export$/i }))
    .toBeInTheDocument();
});

test('no Trust band renders for a not-yet-run backlog task', async () => {
  const screen = render(<EmptyBacklog />);
  await expect.element(screen.getByText('Overview')).toBeInTheDocument();
  expect(screen.getByText('Trust').query()).toBeNull();
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
