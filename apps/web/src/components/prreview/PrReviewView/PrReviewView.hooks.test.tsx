import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri seams (the prreview-runs.hooks.test.tsx pattern): `invoke` is
// controllable per test, and `listen` captures the channel handler so tests can
// push live `nc:pr-review` events straight into the view model's registry.
const invoke = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (channel: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(channel, handler);
    return Promise.resolve(() => listeners.delete(channel));
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { ToastProvider } from '@/components/ui';
import type { PrReviewRun, PrSummary, StoredReviewFinding } from '@/lib/bridge';
import type { ScanTarget } from '@/lib/source-ref';

import { type PrReviewViewModel, usePrReviewView } from './PrReviewView.hooks';

/** Flip the Tauri detection so the bridge wrappers and the `nc:pr-review`
 *  subscription reach the mocks instead of no-opping. */
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  listeners.clear();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function ViewHarness({
  sink,
  preselect = null,
}: {
  sink: (m: PrReviewViewModel) => void;
  preselect?: ScanTarget | null;
}) {
  const model = usePrReviewView({
    projectPath: '/p',
    projectName: 'acme',
    onGotoBoard: () => {},
    preselect,
    onPreselectConsumed: () => {},
  });
  useEffect(() => {
    sink(model);
  });
  return null;
}

/** Push one wire event onto the captured `nc:pr-review` channel. */
function emit(event: unknown) {
  const handler = listeners.get('nc:pr-review');
  if (handler === undefined) throw new Error('nc:pr-review not subscribed');
  handler({ payload: event });
}

function storedFinding(over: Partial<StoredReviewFinding> = {}): StoredReviewFinding {
  return {
    id: 'sf1',
    lens: 'logic',
    severity: 'high',
    file: 'src/a.ts',
    line: null,
    title: 'From the store',
    body: 'b',
    suggestedFix: null,
    fingerprint: 'fp-sf1',
    corroboratedBy: null,
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

function persistedRun(over: Partial<PrReviewRun> = {}): PrReviewRun {
  return {
    id: 'run-10',
    projectPath: '/p',
    prNumber: 42,
    status: 'completed',
    lenses: ['security'],
    model: 'claude',
    createdAt: 1000,
    updatedAt: 2000,
    costUsd: 0,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    findings: [],
    error: null,
    verdict: null,
    verdictReasoning: null,
    headSha: null,
    postedVerdict: null,
    postedAt: null,
    ...over,
  };
}

function summary(over: Partial<PrSummary> & Pick<PrSummary, 'number'>): PrSummary {
  return {
    title: 'Untitled',
    state: 'OPEN',
    headRefName: 'branch',
    author: 'octocat',
    isDraft: false,
    createdAt: '2026-06-20T09:00:00Z',
    updatedAt: '2026-07-02T12:00:00Z',
    url: `https://github.com/o/r/pull/${over.number}`,
    labels: [],
    body: '',
    additions: 0,
    deletions: 0,
    ...over,
  };
}

/** Baseline invoke behavior; tests override per-command via `handlers`. */
function mockCommands(handlers: Record<string, (args: unknown) => unknown>) {
  invoke.mockImplementation((cmd: unknown, args: unknown) => {
    const handler = handlers[cmd as string];
    if (handler !== undefined) return Promise.resolve(handler(args));
    if (cmd === 'list_open_prs') return Promise.resolve([]);
    if (cmd === 'list_pr_review_runs') return Promise.resolve([]);
    if (cmd === 'list_pr_fixes') return Promise.resolve([]);
    if (cmd === 'viewer_login') return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
}

async function mountView(
  preselect: ScanTarget | null = null,
): Promise<() => PrReviewViewModel> {
  let model: PrReviewViewModel | undefined;
  render(
    <ToastProvider>
      <ViewHarness sink={(m) => (model = m)} preselect={preselect} />
    </ToastProvider>,
  );
  await vi.waitFor(() => {
    expect(model).toBeDefined();
    expect(listeners.has('nc:pr-review')).toBe(true);
  });
  return () => model!;
}

test('review section transitions config → running → results as the run streams', async () => {
  let stored: PrReviewRun[] = [];
  mockCommands({
    start_pr_review: () => 'run-1',
    list_pr_review_runs: () => stored,
    get_pr_review_run: () => stored[0] ?? null,
  });
  const model = await mountView();

  // No run known for PR 42 → the section opens in CONFIG.
  model().list.selectPr(42);
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('config'));

  // Review → the optimistic running entry lands → RUNNING.
  model().workspace.review!.configure.onReview();
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('running'));
  expect(model().workspace.review?.stream?.runId).toBe('run-1');
  expect(model().list.runningPrs).toContain(42);

  // The terminal event reconciles against the (now persisted) run → RESULTS.
  stored = [persistedRun({ id: 'run-1', findings: [storedFinding()] })];
  emit({
    type: 'pr-review-completed',
    runId: 'run-1',
    findings: [],
    lensesRun: 1,
    costUsd: 0,
    durationMs: 5,
  });
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('results'));
  expect(model().workspace.review?.results.gridFindings.map((f) => f.id)).toEqual(['sf1']);
});

test('completing a run auto-selects ALL open findings; a user None survives a re-fold', async () => {
  let stored: PrReviewRun[] = [];
  mockCommands({
    start_pr_review: () => 'run-1',
    list_pr_review_runs: () => stored,
    get_pr_review_run: () => stored[0] ?? null,
  });
  const model = await mountView();

  model().list.selectPr(42);
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('config'));
  model().workspace.review!.configure.onReview();
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('running'));

  // Terminal event reconciles against a run carrying two open findings.
  stored = [
    persistedRun({
      id: 'run-1',
      findings: [
        storedFinding({ id: 'a', severity: 'high' }),
        storedFinding({ id: 'b', severity: 'low' }),
      ],
    }),
  ];
  emit({
    type: 'pr-review-completed',
    runId: 'run-1',
    findings: [],
    lensesRun: 1,
    costUsd: 0,
    durationMs: 5,
  });

  // On the transition to completed the whole OPEN set seeds the selection —
  // even the low finding reaches the contributor.
  await vi.waitFor(() =>
    expect([...model().workspace.review!.results.selection].sort()).toEqual(['a', 'b']),
  );

  // The user clears the selection (quick-select None).
  model().workspace.review!.results.onSelectionChange(new Set());
  await vi.waitFor(() => expect(model().workspace.review!.results.selection.size).toBe(0));

  // A re-fold of the SAME run (reconcile now brings a third finding) must NOT
  // re-stomp: auto-select fires at most once per run, so None stands.
  stored = [
    persistedRun({
      id: 'run-1',
      findings: [
        storedFinding({ id: 'a', severity: 'high' }),
        storedFinding({ id: 'b', severity: 'low' }),
        storedFinding({ id: 'c', severity: 'medium' }),
      ],
    }),
  ];
  emit({
    type: 'pr-review-completed',
    runId: 'run-1',
    findings: [],
    lensesRun: 1,
    costUsd: 0,
    durationMs: 5,
  });
  // The reconcile lands (grid grows to 3), proving the effect re-ran…
  await vi.waitFor(() =>
    expect(model().workspace.review!.results.gridFindings.length).toBe(3),
  );
  // …yet the selection is still empty — the user's None was not overwritten.
  expect(model().workspace.review!.results.selection.size).toBe(0);
});

test('a rejected re-run over completed results stays in CONFIG so the error is seen', async () => {
  // Regression (kept from the lifecycle era): a rejected start must not drop
  // the section back to the stale results, where the error is never rendered.
  mockCommands({
    list_pr_review_runs: () => [persistedRun()],
    get_pr_review_run: () => persistedRun(),
    start_pr_review: () => {
      throw new Error('gh: authentication required');
    },
  });
  const model = await mountView();

  model().list.selectPr(42);
  // The mount reconcile projected the completed run → RESULTS.
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('results'));

  // "New review" → prefilled CONFIG over the existing results.
  model().workspace.review!.results.onNewReview();
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('config'));
  expect(model().workspace.review?.configure.onBackToResults).not.toBeNull();

  // Rejected start: the per-PR error surfaces and the section STAYS in config.
  model().workspace.review!.configure.onReview();
  await vi.waitFor(() =>
    expect(model().workspace.review?.configure.startError).toBe('gh: authentication required'),
  );
  expect(model().workspace.review?.mode).toBe('config');
});

test('switching PRs mid-run cancels nothing: both PRs keep their streams', async () => {
  mockCommands({ start_pr_review: () => 'run-42' });
  const model = await mountView();

  model().list.selectPr(42);
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('config'));
  model().workspace.review!.configure.onReview();
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('running'));

  // Switch to PR 7: its panel is fresh CONFIG, while 42 keeps running.
  model().list.selectPr(7);
  await vi.waitFor(() => expect(model().list.selectedPr).toBe(7));
  expect(model().workspace.review?.mode).toBe('config');
  expect(model().list.runningPrs).toContain(42);

  // A live lens event for 42's run keeps folding while PR 7 is selected.
  emit({
    type: 'pr-review-lens-completed',
    runId: 'run-42',
    lens: 'security',
    findings: [
      {
        id: 'w1',
        lens: 'security',
        severity: 'low',
        file: 'src/a.ts',
        title: 'Streamed while away',
        body: 'b',
        fingerprint: 'fp-w1',
      },
    ],
    costUsd: 0.01,
  });

  // Switching back shows the still-running stream with the folded finding.
  model().list.selectPr(42);
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('running'));
  await vi.waitFor(() =>
    expect(model().workspace.review?.stream?.findings.map((f) => f.title)).toEqual([
      'Streamed while away',
    ]),
  );
});

test('history is per-PR; selecting a past run flags it and backToLatest returns', async () => {
  const latest = persistedRun({ id: 'run-a', createdAt: 2000, findings: [storedFinding()] });
  const older = persistedRun({ id: 'run-a2', createdAt: 500 });
  const otherPr = persistedRun({ id: 'run-b', prNumber: 7, createdAt: 1500 });
  mockCommands({
    list_pr_review_runs: () => [latest, older, otherPr],
    get_pr_review_run: (args) => {
      const { runId } = args as { runId: string };
      return [latest, older, otherPr].find((r) => r.id === runId) ?? null;
    },
  });
  const model = await mountView();

  model().list.selectPr(42);
  // Only PR 42's two runs appear, newest first, labeled `<date> · K findings`.
  await vi.waitFor(() => expect(model().workspace.review?.history.items).toHaveLength(2));
  expect(model().workspace.review!.history.items[0]!.label).toContain('1 finding');
  expect(model().workspace.review!.history.items[1]!.label).toContain('0 findings');
  expect(model().workspace.review?.history.viewingPastRun).toBe(false);
  expect(model().workspace.review?.stream?.runId).toBe('run-a');

  // Selecting the older run projects ITS stream with the past-run flag.
  model().workspace.review!.history.items[1]!.onClick();
  await vi.waitFor(() => expect(model().workspace.review?.stream?.runId).toBe('run-a2'));
  expect(model().workspace.review?.history.viewingPastRun).toBe(true);

  // Back to latest.
  model().workspace.review!.history.onBackToLatest();
  await vi.waitFor(() => expect(model().workspace.review?.stream?.runId).toBe('run-a'));
  expect(model().workspace.review?.history.viewingPastRun).toBe(false);
});

test('preselect selects the run’s PR and opens the named finding', async () => {
  const run = persistedRun({ id: 'run-10', findings: [storedFinding({ id: 'sf1' })] });
  mockCommands({ get_pr_review_run: () => run });
  const model = await mountView({
    view: 'prreview',
    family: 'pr-review',
    kind: 'finding',
    runId: 'run-10',
    itemId: 'sf1',
  });

  await vi.waitFor(() => expect(model().list.selectedPr).toBe(42));
  await vi.waitFor(() => expect(model().finding.selected?.id).toBe('sf1'));
  expect(model().workspace.review?.mode).toBe('results');
});

test('the own-PR guard arms from viewerLogin and fails open when login is null', async () => {
  mockCommands({
    viewer_login: () => 'alice',
    list_open_prs: () => [summary({ number: 42, author: 'alice' })],
    list_pr_review_runs: () => [persistedRun({ findings: [storedFinding()] })],
    get_pr_review_run: () => persistedRun({ findings: [storedFinding()] }),
  });
  const model = await mountView();
  model().list.selectPr(42);
  await vi.waitFor(() =>
    expect(model().workspace.review?.results.toolbar.ownPr).toBe(true),
  );
});

test('switching PRs closes the post gate (verdict + error)', async () => {
  const run = persistedRun({ findings: [storedFinding()] });
  mockCommands({
    list_pr_review_runs: () => [run],
    get_pr_review_run: () => run,
  });
  const model = await mountView();
  model().list.selectPr(42);
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('results'));

  model().workspace.review!.results.toolbar.requestPost('approve');
  await vi.waitFor(() => expect(model().post.postVerdict).toBe('approve'));

  // The armed verdict targeted PR 42's displayed run — a switch must not carry
  // the open dialog over to PR 7.
  model().list.selectPr(7);
  await vi.waitFor(() => expect(model().post.postVerdict).toBeNull());
  expect(model().post.postError).toBeNull();
});

test('a preselect landing while a gate dialog is open closes all three gates', async () => {
  const run = persistedRun({ id: 'run-10', findings: [storedFinding({ id: 'sf1' })] });
  mockCommands({
    list_pr_review_runs: () => [run],
    get_pr_review_run: () => run,
  });
  let model: PrReviewViewModel | undefined;
  const screen = render(
    <ToastProvider>
      <ViewHarness sink={(m) => (model = m)} preselect={null} />
    </ToastProvider>,
  );
  await vi.waitFor(() => {
    expect(model).toBeDefined();
    expect(listeners.has('nc:pr-review')).toBe(true);
  });
  model!.list.selectPr(42);
  await vi.waitFor(() => expect(model!.workspace.review?.mode).toBe('results'));
  model!.workspace.review!.results.toolbar.requestPost('approve');
  await vi.waitFor(() => expect(model!.post.postVerdict).toBe('approve'));

  // The provenance navigation bypasses selectPr — it must still close every
  // human gate armed against the previous selection.
  screen.rerender(
    <ToastProvider>
      <ViewHarness
        sink={(m) => (model = m)}
        preselect={{
          view: 'prreview',
          family: 'pr-review',
          kind: 'finding',
          runId: 'run-10',
          itemId: 'sf1',
        }}
      />
    </ToastProvider>,
  );
  await vi.waitFor(() => expect(model!.finding.selected?.id).toBe('sf1'));
  expect(model!.post.postVerdict).toBeNull();
  expect(model!.post.postError).toBeNull();
  expect(model!.address.addressArmed).toBe(false);
  expect(model!.fix.pushArmedFix).toBeNull();
});

test('a failed dismiss restores the finding into the post selection', async () => {
  const run = persistedRun({ findings: [storedFinding()] });
  let rejectDismiss: (e: Error) => void = () => {};
  mockCommands({
    list_pr_review_runs: () => [run],
    get_pr_review_run: () => run,
    dismiss_review_finding: () =>
      new Promise((_resolve, reject) => {
        rejectDismiss = reject;
      }),
  });
  const model = await mountView();
  model().list.selectPr(42);
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('results'));

  // The run completed with one open finding → auto-selected into the post set.
  await vi.waitFor(() =>
    expect(model().workspace.review?.results.selection.has('sf1')).toBe(true),
  );

  // Dismiss deselects optimistically while the RPC is in flight…
  model().finding.onDismiss('sf1');
  await vi.waitFor(() =>
    expect(model().workspace.review?.results.selection.has('sf1')).toBe(false),
  );

  // …and the rejected RPC rolls the deselect back: the finding is still open
  // and postable, so silently shrinking the selection would be a lie.
  rejectDismiss(new Error('store write failed'));
  await vi.waitFor(() =>
    expect(model().workspace.review?.results.selection.has('sf1')).toBe(true),
  );
  expect(model().finding.pending).toBe(false);
});

test('a rejected address toasts the failure besides the inline error, keeping the gate open', async () => {
  const run = persistedRun({ findings: [storedFinding()] });
  mockCommands({
    list_pr_review_runs: () => [run],
    get_pr_review_run: () => run,
    address_review_findings: () => {
      throw new Error('the PR head is on a fork');
    },
  });
  let model: PrReviewViewModel | undefined;
  const screen = render(
    <ToastProvider>
      <ViewHarness sink={(m) => (model = m)} />
    </ToastProvider>,
  );
  await vi.waitFor(() => {
    expect(model).toBeDefined();
    expect(listeners.has('nc:pr-review')).toBe(true);
  });
  model!.list.selectPr(42);
  await vi.waitFor(() => expect(model!.workspace.review?.mode).toBe('results'));
  // The single open finding auto-selects on completion → addressCount 1.
  await vi.waitFor(() => expect(model!.address.addressCount).toBe(1));

  model!.workspace.review!.results.toolbar.requestAddress();
  await vi.waitFor(() => expect(model!.address.addressArmed).toBe(true));
  model!.address.confirmAddress();

  await vi.waitFor(() =>
    expect(model!.address.addressError).toBe('the PR head is on a fork'),
  );
  // The gate stays open for retry/cancel AND the failure toasts (post/push parity).
  expect(model!.address.addressArmed).toBe(true);
  await expect
    .element(screen.getByText('Could not start the fix agent'))
    .toBeInTheDocument();
});

test('own-PR guard fails open when the viewer login is unknown', async () => {
  mockCommands({
    viewer_login: () => null,
    list_open_prs: () => [summary({ number: 42, author: 'alice' })],
    list_pr_review_runs: () => [persistedRun({ findings: [storedFinding()] })],
    get_pr_review_run: () => persistedRun({ findings: [storedFinding()] }),
  });
  const model = await mountView();
  model().list.selectPr(42);
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('results'));
  expect(model().workspace.review?.results.toolbar.ownPr).toBe(false);
});

test('a failed "Load more" keeps the already-loaded rows instead of wiping the list', async () => {
  let call = 0;
  const firstPage = Array.from({ length: 50 }, (_, i) => summary({ number: i + 1 }));
  mockCommands({
    list_open_prs: () => {
      call += 1;
      if (call === 1) return firstPage;
      // The doubled-cap refetch hits a transient gh failure.
      throw new Error('gh: could not fetch more');
    },
  });
  const model = await mountView();

  // The initial fetch fills the cap, so the picker offers "Load more".
  await vi.waitFor(() => expect(model().list.prs.length).toBe(50));
  expect(model().list.prsHasMore).toBe(true);

  // A load-more failure must NOT drop the rows already on screen — the loading-
  // more contract is "rows stay put". The error surfaces beside the kept list.
  model().list.loadMorePrs();
  await vi.waitFor(() => expect(model().list.prsError).toBe('gh: could not fetch more'));
  expect(model().list.prs.length).toBe(50);
  // …but the footer stops offering more (the doubled cap didn't land).
  expect(model().list.prsHasMore).toBe(false);
});

test('a successful post reloads the run so the Posted lifecycle surfaces at once', async () => {
  // `post_review_to_github` stamps postedVerdict server-side but emits no event,
  // so the client must reload the run — otherwise the workspace keeps reading
  // "Reviewed / pending post" until an unrelated interaction refreshes the runs.
  let posted = false;
  const stamp = (r: PrReviewRun): PrReviewRun =>
    posted ? { ...r, postedVerdict: 'approve', postedAt: 3000 } : r;
  const base = persistedRun({ id: 'run-10', findings: [storedFinding()] });
  mockCommands({
    list_pr_review_runs: () => [stamp(base)],
    get_pr_review_run: () => stamp(base),
    post_review_to_github: () => {
      posted = true;
      return null;
    },
  });
  const model = await mountView();
  model().list.selectPr(42);
  await vi.waitFor(() => expect(model().workspace.review?.mode).toBe('results'));
  // The single open finding auto-selects on completion → the post gate can arm.
  await vi.waitFor(() =>
    expect(model().workspace.review?.results.selection.has('sf1')).toBe(true),
  );

  model().workspace.review!.results.toolbar.requestPost('approve');
  await vi.waitFor(() => expect(model().post.postVerdict).toBe('approve'));
  model().post.confirmPost();

  // The reload surfaces the server stamp with no further interaction: the status
  // line reads Posted and the timeline gains its "Posted to GitHub" node.
  await vi.waitFor(() => expect(model().workspace.lifecycle?.state).toBe('posted'));
  expect(
    model().workspace.review!.results.timeline.some((s) => s.label === 'Posted to GitHub'),
  ).toBe(true);
});
