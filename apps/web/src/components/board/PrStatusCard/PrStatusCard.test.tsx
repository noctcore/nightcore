import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri command surface underneath the bridge (the CreatePRDialog.test
// seam) so `pr_status` / `push_pr_updates` / `finalize_merged_pr` / `pull_base_ff`
// are observable. The bridge gates the real calls on `isTauri()`, satisfied by
// stubbing `window.__TAURI_INTERNALS__` in `beforeEach`.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import type { PrStatus, Task } from '@/lib/bridge';
import { finalizeMergedPr, pullBaseFf, pushPrUpdates } from '@/lib/bridge';

import { makePrStatus, makeTask } from '../_fixtures';
import { PrStatusCard } from './PrStatusCard';
import {
  canFinalize,
  canPullBase,
  canPushUpdates,
  mergeStateLine,
  prStateBadge,
  reviewDecisionBadge,
} from './PrStatusCard.hooks';

const TASK: Task = makeTask({
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

/** Route the mocked invoke per command; tests override single commands. */
function stubCommands(overrides: Record<string, (args: unknown) => Promise<unknown>> = {}) {
  invoke.mockImplementation((cmd: unknown, args: unknown) => {
    const override = overrides[cmd as string];
    if (override !== undefined) return override(args);
    if (cmd === 'pr_status') return Promise.resolve(makePrStatus());
    return Promise.resolve(undefined);
  });
}

/** Count how many times a command was invoked. */
function calls(cmd: string): number {
  return invoke.mock.calls.filter(([c]) => c === cmd).length;
}

/** Render the card with production-like wiring: handlers relay to the bridge
 *  (the AppShell adds guarding/toasts on top — tested in usePrLifecycle). */
function renderCard(task: Task = TASK) {
  return render(
    <PrStatusCard
      task={task}
      onOpenPr={() => {}}
      onPushUpdates={(id) => pushPrUpdates(id)}
      onFinalize={(id) => finalizeMergedPr(id)}
      onPullBase={(id) => pullBaseFf(id)}
    />,
  );
}

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

test('renders Open + Approved badges and the checks summary from pr_status', async () => {
  stubCommands({
    pr_status: () =>
      Promise.resolve(
        makePrStatus({
          reviewDecision: 'APPROVED',
          checksPassed: 3,
          checksFailed: 1,
          checksPending: 2,
        }),
      ),
  });
  const screen = renderCard();
  await expect.element(screen.getByText('Open')).toBeInTheDocument();
  await expect.element(screen.getByText('Approved')).toBeInTheDocument();
  await expect.element(screen.getByText('3 passed')).toBeInTheDocument();
  await expect.element(screen.getByText('1 failed')).toBeInTheDocument();
  await expect.element(screen.getByText('2 pending')).toBeInTheDocument();
  // The web-side receive timestamp is stamped and rendered.
  await expect.element(screen.getByText(/^Refreshed /)).toBeInTheDocument();
});

test('Draft wins over Open when isDraft is set', async () => {
  stubCommands({
    pr_status: () => Promise.resolve(makePrStatus({ isDraft: true })),
  });
  const screen = renderCard();
  await expect.element(screen.getByText('Draft')).toBeInTheDocument();
  expect(screen.getByText('Open').query()).toBeNull();
});

test('a merged PR shows the Merged badge and a changes-requested one its badge', async () => {
  stubCommands({
    pr_status: () =>
      Promise.resolve(makePrStatus({ state: 'MERGED', reviewDecision: 'CHANGES_REQUESTED' })),
  });
  const screen = renderCard();
  await expect.element(screen.getByText('Merged')).toBeInTheDocument();
  await expect.element(screen.getByText('Changes requested')).toBeInTheDocument();
});

test('hides the checks line when every count is zero', async () => {
  stubCommands();
  const screen = renderCard();
  await expect.element(screen.getByText('Open')).toBeInTheDocument();
  expect(screen.getByText(/passed/).query()).toBeNull();
});

test('unknown gh vocabulary degrades to the raw strings', async () => {
  stubCommands({
    pr_status: () =>
      Promise.resolve(
        makePrStatus({
          state: 'SUPERSEDED',
          reviewDecision: 'ESCALATED',
        }),
      ),
  });
  const screen = renderCard();
  await expect.element(screen.getByText('SUPERSEDED')).toBeInTheDocument();
  await expect.element(screen.getByText('ESCALATED')).toBeInTheDocument();
});

test('mergeStateLine maps known values and degrades unknown ones raw', () => {
  expect(mergeStateLine(makePrStatus({ mergeable: 'CONFLICTING' }))).toBe('Conflicts with base');
  expect(mergeStateLine(makePrStatus({ mergeStateStatus: 'BEHIND' }))).toBe('Behind base');
  expect(mergeStateLine(makePrStatus({ mergeStateStatus: 'CLEAN' }))).toBe('Clean against base');
  // Unknown vocabulary: the raw strings, never a guess.
  expect(mergeStateLine(makePrStatus({ mergeStateStatus: 'HAS_HOOKS' }))).toBe(
    'MERGEABLE · HAS_HOOKS',
  );
  // Meaningless once the PR is no longer open.
  expect(mergeStateLine(makePrStatus({ state: 'MERGED' }))).toBeNull();
});

test('badge helpers pass unknown values through raw', () => {
  expect(prStateBadge(makePrStatus({ state: 'WEIRD' })).label).toBe('WEIRD');
  expect(reviewDecisionBadge(makePrStatus({ reviewDecision: '' }))).toBeNull();
  expect(reviewDecisionBadge(makePrStatus({ reviewDecision: 'ESCALATED' }))?.label).toBe(
    'ESCALATED',
  );
});

test('Refresh is disabled while a fetch is pending and refetches on click', async () => {
  let resolveSecond: ((s: PrStatus) => void) | undefined;
  let call = 0;
  stubCommands({
    pr_status: () => {
      call += 1;
      if (call === 1) return Promise.resolve(makePrStatus());
      return new Promise<PrStatus>((resolve) => {
        resolveSecond = resolve;
      });
    },
  });
  const screen = renderCard();
  const refresh = screen.getByRole('button', { name: /refresh/i });
  await expect.element(refresh).toBeEnabled();

  await refresh.click();
  await expect.element(refresh).toBeDisabled();

  resolveSecond!(makePrStatus({ reviewDecision: 'APPROVED' }));
  await expect.element(refresh).toBeEnabled();
  await expect.element(screen.getByText('Approved')).toBeInTheDocument();
  expect(calls('pr_status')).toBe(2);
});

test('push-updates visibility contract: OPEN with unpushed commits only', () => {
  expect(canPushUpdates(makePrStatus({ unpushedCommits: 2 }))).toBe(true);
  expect(canPushUpdates(makePrStatus({ unpushedCommits: 0 }))).toBe(false);
  expect(canPushUpdates(makePrStatus({ state: 'MERGED', unpushedCommits: 2 }))).toBe(false);
  expect(canPushUpdates(makePrStatus({ state: 'CLOSED', unpushedCommits: 2 }))).toBe(false);
  // A null count = "cannot determine" (the upstream is unresolvable): the
  // button MUST stay armed — a `-u` re-push recreates a pruned upstream, and
  // hiding it would funnel the user to Finalize, the exact wrong direction.
  expect(canPushUpdates(makePrStatus({ unpushedCommits: null }))).toBe(true);
  expect(canPushUpdates(makePrStatus({ state: 'MERGED', unpushedCommits: null }))).toBe(false);
});

test('a null unpushed count keeps Push updates armed without inventing a number', async () => {
  stubCommands({
    pr_status: () => Promise.resolve(makePrStatus({ unpushedCommits: null })),
  });
  const screen = renderCard();
  // The button shows WITHOUT a count suffix, and the info line explains the
  // unknown count instead of claiming "0" or a fake number.
  const push = screen.getByRole('button', { name: /^push updates$/i });
  await expect.element(push).toBeInTheDocument();
  await expect
    .element(screen.getByText(/Unpushed commits could not be counted/))
    .toBeInTheDocument();

  // The confirm copy states the unknown count too.
  await push.click();
  await expect
    .element(screen.getByText(/the exact commit count is unknown/))
    .toBeInTheDocument();
});

test('no Push updates button without unpushed commits', async () => {
  stubCommands();
  const screen = renderCard();
  await expect.element(screen.getByText('Open')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /push updates/i }).query()).toBeNull();
});

test('Push updates confirms with branch + count, fires the push, then refetches', async () => {
  stubCommands({
    pr_status: () => Promise.resolve(makePrStatus({ unpushedCommits: 2 })),
  });
  const screen = renderCard();
  await screen.getByRole('button', { name: 'Push updates (2)' }).click();

  // The human gate names the branch and the count; nothing has fired yet.
  await expect.element(screen.getByText(/2 commits on nc\/auth-guard/)).toBeInTheDocument();
  expect(calls('push_pr_updates')).toBe(0);

  // The card button's name contains the confirm's — scope to the dialog.
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Push updates' }).click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('push_pr_updates', { id: 't-pr' }));
  // Success refetches the status (mount + post-push).
  await vi.waitFor(() => expect(calls('pr_status')).toBe(2));
});

test('cancelling the push confirm fires nothing', async () => {
  stubCommands({
    pr_status: () => Promise.resolve(makePrStatus({ unpushedCommits: 1 })),
  });
  const screen = renderCard();
  await screen.getByRole('button', { name: 'Push updates (1)' }).click();
  await screen.getByRole('button', { name: 'Cancel' }).click();
  expect(calls('push_pr_updates')).toBe(0);
  expect(calls('pr_status')).toBe(1);
});

test('a rejected push leaves the card intact and skips the refetch', async () => {
  stubCommands({
    pr_status: () => Promise.resolve(makePrStatus({ unpushedCommits: 2 })),
    push_pr_updates: () => Promise.reject(new Error('remote rejected the push')),
  });
  const screen = renderCard();
  await screen.getByRole('button', { name: 'Push updates (2)' }).click();
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Push updates' }).click();
  await vi.waitFor(() => expect(calls('push_pr_updates')).toBe(1));
  // Failure surfacing is the shell controller's toast; the card refetches only
  // on success, so the failed push leaves the single mount fetch.
  await expect.element(screen.getByText('Open')).toBeInTheDocument();
  expect(calls('pr_status')).toBe(1);
});

test('finalize/pull-base visibility contract splits on task.merged', () => {
  const merged = makePrStatus({ state: 'MERGED' });
  expect(canFinalize(merged, TASK)).toBe(true);
  expect(canPullBase(merged, TASK)).toBe(false);
  const finalized = makeTask({ ...TASK, merged: true });
  expect(canFinalize(merged, finalized)).toBe(false);
  expect(canPullBase(merged, finalized)).toBe(true);
  // Never for a PR that is not remote-merged.
  expect(canFinalize(makePrStatus(), TASK)).toBe(false);
  expect(canPullBase(makePrStatus(), finalized)).toBe(false);
});

test('Finalize shows for a remote-merged, not-yet-finalized task and fires the command', async () => {
  stubCommands({ pr_status: () => Promise.resolve(makePrStatus({ state: 'MERGED' })) });
  const screen = renderCard();
  await screen.getByRole('button', { name: /finalize/i }).click();
  // The confirm explains the local effects; nothing fired yet.
  await expect.element(screen.getByText(/marks the task merged locally/)).toBeInTheDocument();
  expect(calls('finalize_merged_pr')).toBe(0);

  // The card button and the dialog confirm share the label — scope to the dialog.
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Finalize' }).click();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('finalize_merged_pr', { id: 't-pr' }),
  );
});

test('an open PR never offers Finalize', async () => {
  stubCommands();
  const screen = renderCard();
  await expect.element(screen.getByText('Open')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /finalize/i }).query()).toBeNull();
});

test('Update base branch shows once finalized and fires pull_base_ff from its confirm', async () => {
  stubCommands({ pr_status: () => Promise.resolve(makePrStatus({ state: 'MERGED' })) });
  const screen = renderCard(makeTask({ ...TASK, merged: true }));
  expect(screen.getByRole('button', { name: /finalize/i }).query()).toBeNull();

  await screen.getByRole('button', { name: 'Update base branch' }).click();
  // The confirm names the base and the fast-forward-only contract.
  await expect.element(screen.getByText(/Fast-forward-only pull of main/)).toBeInTheDocument();
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Update base' }).click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('pull_base_ff', { id: 't-pr' }));
});

test('a pr_status failure shows the error inline and Refresh retries', async () => {
  let call = 0;
  stubCommands({
    pr_status: () => {
      call += 1;
      return call === 1
        ? Promise.reject(new Error('gh: could not resolve the PR'))
        : Promise.resolve(makePrStatus());
    },
  });
  const screen = renderCard();
  await expect.element(screen.getByText('gh: could not resolve the PR')).toBeInTheDocument();
  await screen.getByRole('button', { name: /refresh/i }).click();
  await expect.element(screen.getByText('Open')).toBeInTheDocument();
  expect(screen.getByText('gh: could not resolve the PR').query()).toBeNull();
});
