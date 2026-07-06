import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri command surface underneath the bridge (the PrStatusCard.test
// seam) so `list_pr_comments` is observable for the lifted-hook probe. The bridge
// gates the real calls on `isTauri()`, satisfied by stubbing
// `window.__TAURI_INTERNALS__` in `beforeEach`.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import type { PrReviewComments as PrReviewCommentsPayload, Task } from '@/lib/bridge';

import { makePrReviewComments, makeTask, makeTaskActions } from '../_fixtures';
import { TaskActionsProvider } from '../actions';
import { PrReviewComments } from './PrReviewComments';
import {
  actionableCount,
  addressConfirmCopy,
  canAddressComments,
  type PrReviewCommentsView,
  reviewStateBadge,
  threadAnchor,
  triageClassChip,
  triageForIndex,
  usePrReviewComments,
} from './PrReviewComments.hooks';

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

/** Build the lifted view the component renders from (no self-fetch). */
function makeView(
  comments: PrReviewCommentsPayload | null,
  extra: Partial<PrReviewCommentsView> = {},
): PrReviewCommentsView {
  return {
    comments,
    fetching: false,
    error: null,
    unavailable: comments === null,
    refreshedAt: 1_718_900_000_000,
    refresh: vi.fn(),
    ...extra,
  };
}

/** Render the section with a constructed view + a stub address handler, wrapped
 *  in the provider the app supplies the handler through. */
function renderComments(
  view: PrReviewCommentsView,
  task: Task = TASK,
  onAddressComments: (id: string) => Promise<void> = async () => {},
) {
  return render(
    <TaskActionsProvider actions={makeTaskActions({ onAddressPrComments: onAddressComments })}>
      <PrReviewComments task={task} view={view} />
    </TaskActionsProvider>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

test('renders the inline threads and review summaries with their authors and bodies', async () => {
  const screen = renderComments(makeView(makePrReviewComments()));
  await expect.element(screen.getByText('src/auth/guard.ts:42')).toBeInTheDocument();
  await expect
    .element(screen.getByText(/This guard never handles the null-session case/))
    .toBeInTheDocument();
  // Review summary: author + state badge + body.
  await expect.element(screen.getByText('Changes requested')).toBeInTheDocument();
  await expect
    .element(screen.getByText(/A couple of edge cases need covering/))
    .toBeInTheDocument();
  // The summary line names the total actionable count (1 thread + 1 review).
  await expect.element(screen.getByText('2 unresolved comments')).toBeInTheDocument();
});

test('renders an untrusted comment body as PLAIN TEXT (never HTML)', async () => {
  const screen = renderComments(
    makeView(
      makePrReviewComments({
        threads: [
          {
            path: 'src/x.ts',
            line: 1,
            isOutdated: false,
            comments: [{ author: 'attacker', body: '<script>alert(1)</script> please fix' }],
          },
        ],
        reviews: [],
      }),
    ),
  );
  // The literal markup renders as text content — no <script> element is created.
  await expect
    .element(screen.getByText(/<script>alert\(1\)<\/script> please fix/))
    .toBeInTheDocument();
  expect(screen.container.querySelector('script')).toBeNull();
});

test('shows an "outdated" badge on an outdated thread', async () => {
  const screen = renderComments(
    makeView(
      makePrReviewComments({
        threads: [
          {
            path: 'src/x.ts',
            line: null,
            isOutdated: true,
            comments: [{ author: 'octo', body: 'stale' }],
          },
        ],
        reviews: [],
      }),
    ),
  );
  await expect.element(screen.getByText('outdated')).toBeInTheDocument();
  // A pathless line-less thread anchors to its path only.
  await expect.element(screen.getByText('src/x.ts')).toBeInTheDocument();
});

test('shows the empty note and a disabled Address button when there are no comments', async () => {
  const screen = renderComments(makeView(makePrReviewComments({ threads: [], reviews: [] })));
  await expect.element(screen.getByText('No unresolved review comments.')).toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: 'Address comments' }))
    .toBeDisabled();
});

test('disables Address while the task is running', async () => {
  const screen = renderComments(makeView(makePrReviewComments()), makeTask({ ...TASK, status: 'in_progress' }));
  await expect
    .element(screen.getByRole('button', { name: 'Address comments' }))
    .toBeDisabled();
});

test('disables Address once the task is merged', async () => {
  const screen = renderComments(makeView(makePrReviewComments()), makeTask({ ...TASK, merged: true }));
  await expect
    .element(screen.getByRole('button', { name: 'Address comments' }))
    .toBeDisabled();
});

test('arms + fires onAddressComments from the confirm dialog', async () => {
  const onAddress = vi.fn(async () => {});
  const screen = renderComments(makeView(makePrReviewComments()), TASK, onAddress);
  await screen.getByRole('button', { name: 'Address comments' }).click();
  // Human gate: nothing fires until the dialog confirm; the dialog names the count.
  await expect
    .element(screen.getByText(/Start a fix run to address 2 review comments/))
    .toBeInTheDocument();
  expect(onAddress).not.toHaveBeenCalled();
  // The card button and dialog confirm share the label — scope to the dialog.
  await screen.getByRole('alertdialog').getByRole('button', { name: 'Address comments' }).click();
  await vi.waitFor(() => expect(onAddress).toHaveBeenCalledWith('t-pr'));
});

test('cancelling the address confirm fires nothing', async () => {
  const onAddress = vi.fn(async () => {});
  const screen = renderComments(makeView(makePrReviewComments()), TASK, onAddress);
  await screen.getByRole('button', { name: 'Address comments' }).click();
  await screen.getByRole('button', { name: 'Cancel' }).click();
  expect(onAddress).not.toHaveBeenCalled();
});

test('Refresh calls the view refresh handler', async () => {
  const refresh = vi.fn();
  const screen = renderComments(makeView(makePrReviewComments(), { refresh }));
  await screen.getByRole('button', { name: /refresh/i }).click();
  expect(refresh).toHaveBeenCalledOnce();
});

test('shows the browser-preview unavailable note for a null payload', async () => {
  const screen = renderComments(makeView(null));
  await expect
    .element(screen.getByText(/Review comments are unavailable in the browser preview/))
    .toBeInTheDocument();
});

test('actionableCount sums threads and reviews', () => {
  expect(actionableCount(null)).toBe(0);
  expect(actionableCount({ threads: [], reviews: [] })).toBe(0);
  expect(actionableCount(makePrReviewComments())).toBe(2);
});

test('canAddressComments gates on comments + not-merged + not-running', () => {
  const comments = makePrReviewComments();
  expect(canAddressComments(TASK, comments)).toBe(true);
  expect(canAddressComments(TASK, { threads: [], reviews: [] })).toBe(false);
  expect(canAddressComments(makeTask({ ...TASK, merged: true }), comments)).toBe(false);
  expect(canAddressComments(makeTask({ ...TASK, status: 'in_progress' }), comments)).toBe(false);
  expect(canAddressComments(makeTask({ ...TASK, status: 'verifying' }), comments)).toBe(false);
});

test('reviewStateBadge maps known states and degrades unknown ones raw', () => {
  expect(reviewStateBadge('APPROVED').label).toBe('Approved');
  expect(reviewStateBadge('CHANGES_REQUESTED').label).toBe('Changes requested');
  expect(reviewStateBadge('PENDING').label).toBe('Pending');
  // Unknown gh vocabulary: the raw string, never a guess.
  expect(reviewStateBadge('ESCALATED').label).toBe('ESCALATED');
});

test('threadAnchor renders path:line, path-only, and (general)', () => {
  expect(threadAnchor('src/x.ts', 42)).toBe('src/x.ts:42');
  expect(threadAnchor('src/x.ts', null)).toBe('src/x.ts');
  expect(threadAnchor(null, null)).toBe('(general)');
  expect(threadAnchor(null, 7)).toBe('(general):7');
});

test('addressConfirmCopy names the count with correct pluralization', () => {
  expect(addressConfirmCopy(1).message).toContain('1 review comment?');
  expect(addressConfirmCopy(3).message).toContain('3 review comments?');
  expect(addressConfirmCopy(2).confirmLabel).toBe('Address comments');
});

test('usePrReviewComments fetches on mount and refetches on refresh', async () => {
  let call = 0;
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'list_pr_comments') {
      call += 1;
      return Promise.resolve(
        call === 1
          ? makePrReviewComments({ threads: [], reviews: [] })
          : makePrReviewComments(),
      );
    }
    return Promise.resolve(undefined);
  });

  function Probe({ taskId }: { taskId: string }) {
    const view = usePrReviewComments(taskId, true);
    return (
      <div>
        <span>count:{actionableCount(view.comments)}</span>
        <button onClick={view.refresh}>refresh</button>
      </div>
    );
  }

  const screen = render(<Probe taskId="t-pr" />);
  await expect.element(screen.getByText('count:0')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'refresh' }).click();
  await expect.element(screen.getByText('count:2')).toBeInTheDocument();
  expect(invoke.mock.calls.filter(([c]) => c === 'list_pr_comments').length).toBe(2);
});

test('Triage classifies the threads and renders a class chip with its note tooltip', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'triage_pr_comments'
      ? Promise.resolve([{ index: 0, class: 'false_positive', note: 'the concern does not apply' }])
      : Promise.resolve(undefined),
  );
  // Default fixture: one inline thread → the Triage button is present.
  const screen = renderComments(makeView(makePrReviewComments()));
  await screen.getByRole('button', { name: /triage/i }).click();
  // The thread now carries a class chip; its note rides as the tooltip.
  await expect.element(screen.getByText('False positive')).toBeInTheDocument();
  await expect
    .element(screen.getByTitle('the concern does not apply'))
    .toBeInTheDocument();
  expect(invoke.mock.calls.filter(([c]) => c === 'triage_pr_comments').length).toBe(1);
});

test('hides the Triage button when there are no threads to classify', async () => {
  // Reviews present but zero inline threads → nothing to triage.
  const screen = renderComments(
    makeView(
      makePrReviewComments({
        threads: [],
        reviews: [{ author: 'octo', state: 'COMMENTED', body: 'note' }],
      }),
    ),
  );
  await expect.element(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  expect(screen.container.querySelector('button[title^="Classify"]')).toBeNull();
});

test('triageClassChip maps each class to its label + tone', () => {
  expect(triageClassChip('actionable').label).toBe('Actionable');
  expect(triageClassChip('actionable').className).toContain('warning');
  expect(triageClassChip('false_positive').label).toBe('False positive');
  expect(triageClassChip('false_positive').className).toContain('muted');
  expect(triageClassChip('already_addressed').label).toBe('Addressed');
  expect(triageClassChip('already_addressed').className).toContain('success');
  expect(triageClassChip('question').label).toBe('Question');
  expect(triageClassChip('question').className).toContain('primary');
});

test('triageForIndex finds a thread verdict or returns undefined', () => {
  const verdicts = [
    { index: 0, class: 'actionable' as const, note: '' },
    { index: 1, class: 'question' as const, note: 'ask on the PR' },
  ];
  expect(triageForIndex(verdicts, 1)?.class).toBe('question');
  expect(triageForIndex(verdicts, 5)).toBeUndefined();
  expect(triageForIndex(null, 0)).toBeUndefined();
});

test('a changed thread set (a refresh) invalidates the index-aligned triage chips', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'triage_pr_comments'
      ? Promise.resolve([{ index: 0, class: 'false_positive', note: 'n/a' }])
      : Promise.resolve(undefined),
  );
  const threadA = makePrReviewComments({
    threads: [
      { path: 'src/a.ts', line: 1, isOutdated: false, comments: [{ author: 'r', body: 'A' }] },
    ],
    reviews: [],
  });
  const screen = renderComments(makeView(threadA));
  await screen.getByRole('button', { name: /triage/i }).click();
  await expect.element(screen.getByText('False positive')).toBeInTheDocument();

  // A Refresh brings a DIFFERENT thread set (the old thread resolved, a new one
  // landed). The verdicts index-align to the threads, so they no longer apply —
  // the chip must clear rather than mis-attach to the now-different thread.
  const threadB = makePrReviewComments({
    threads: [
      { path: 'src/z.ts', line: 9, isOutdated: false, comments: [{ author: 'r', body: 'Z' }] },
    ],
    reviews: [],
  });
  screen.rerender(
    <TaskActionsProvider actions={makeTaskActions({ onAddressPrComments: async () => {} })}>
      <PrReviewComments task={TASK} view={makeView(threadB)} />
    </TaskActionsProvider>,
  );
  await expect.element(screen.getByText('src/z.ts:9')).toBeInTheDocument();
  await expect.element(screen.getByText('False positive')).not.toBeInTheDocument();
});

test('a fetch error is announced via role="alert"', async () => {
  const screen = renderComments(
    makeView(makePrReviewComments(), { error: 'gh: rate limited' }),
  );
  const alert = screen.getByText('gh: rate limited');
  await expect.element(alert).toBeInTheDocument();
  await expect.element(alert).toHaveAttribute('role', 'alert');
});

test('usePrReviewComments resets its payload on a task switch', async () => {
  invoke.mockImplementation((cmd: unknown, args: unknown) =>
    cmd === 'list_pr_comments'
      ? (args as { id: string }).id === 't-pr'
        ? Promise.resolve(makePrReviewComments())
        : new Promise(() => {}) // task B never resolves
      : Promise.resolve(undefined),
  );

  function Probe({ taskId }: { taskId: string }) {
    const view = usePrReviewComments(taskId, true);
    return <span>count:{actionableCount(view.comments)}</span>;
  }

  const screen = render(<Probe taskId="t-pr" />);
  await expect.element(screen.getByText('count:2')).toBeInTheDocument();
  // Switching tasks must not leak A's payload while B's fetch is pending.
  screen.rerender(<Probe taskId="t-pr-b" />);
  await expect.element(screen.getByText('count:0')).toBeInTheDocument();
});
