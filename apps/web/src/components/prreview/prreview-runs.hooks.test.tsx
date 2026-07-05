import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri seams (the PrReviewView.hooks.test.tsx pattern): `invoke` is
// controllable per test, and `listen` captures the channel handler so tests can
// push live `nc:pr-review` events straight into the registry hook.
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

import type { PrReviewRun, ReviewLens, StoredReviewFinding } from '@/lib/bridge';

import {
  usePrReviewRuns,
  type UsePrReviewRunsResult,
} from './prreview-runs.hooks';

const SECURITY: ReviewLens[] = ['security'];

/** Flip the Tauri detection so the bridge's wrappers and the `nc:pr-review`
 *  subscription reach the mocks instead of no-opping. */
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  listeners.clear();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function Harness({ sink }: { sink: (api: UsePrReviewRunsResult) => void }) {
  const api = usePrReviewRuns(true);
  useEffect(() => {
    sink(api);
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
    id: 'run-1',
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

async function mountHook(): Promise<() => UsePrReviewRunsResult> {
  let api: UsePrReviewRunsResult | undefined;
  render(<Harness sink={(a) => (api = a)} />);
  await vi.waitFor(() => {
    expect(api).toBeDefined();
    expect(listeners.has('nc:pr-review')).toBe(true);
  });
  return () => api!;
}

test('double-start of the SAME PR is guarded; DIFFERENT PRs start concurrently', async () => {
  const resolvers: Array<(runId: string) => void> = [];
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'start_pr_review') {
      return new Promise((resolve) => resolvers.push(resolve as (r: string) => void));
    }
    return Promise.resolve([]);
  });
  const api = await mountHook();

  // Two synchronous clicks on PR 42 + one on PR 7, all inside the IPC gap.
  const first = api().start(42, SECURITY);
  const second = api().start(42, SECURITY);
  const other = api().start(7, SECURITY);

  await expect(second).resolves.toBeNull();
  expect(invoke.mock.calls.filter((c) => c[0] === 'start_pr_review')).toHaveLength(2);

  resolvers[0]!('run-42');
  resolvers[1]!('run-7');
  await expect(first).resolves.toBe('run-42');
  await expect(other).resolves.toBe('run-7');

  // Both optimistic streams land, each carrying its own PR number.
  await vi.waitFor(() => {
    expect(api().byPr(42).isRunning).toBe(true);
    expect(api().byPr(7).isRunning).toBe(true);
  });
  expect(api().byPr(42).stream?.runId).toBe('run-42');
  expect(api().byPr(7).stream?.runId).toBe('run-7');
});

test('start() refuses a PR whose run is already streaming in the registry', async () => {
  // The store already holds a RUNNING run for PR 42 (e.g. started pre-remount).
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'list_pr_review_runs') {
      return Promise.resolve([persistedRun({ id: 'run-live', status: 'running' })]);
    }
    return Promise.resolve(undefined);
  });
  const api = await mountHook();
  await vi.waitFor(() => expect(api().byPr(42).isRunning).toBe(true));

  await expect(api().start(42, SECURITY)).resolves.toBeNull();
  expect(invoke.mock.calls.filter((c) => c[0] === 'start_pr_review')).toHaveLength(0);
});

test('a rejected start records a per-PR startError and resolves null', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'start_pr_review'
      ? Promise.reject(new Error('no pull request found for #999'))
      : Promise.resolve([]),
  );
  const api = await mountHook();

  await expect(api().start(999, SECURITY)).resolves.toBeNull();
  await vi.waitFor(() =>
    expect(api().startErrors.get(999)).toBe('no pull request found for #999'),
  );
});

test('a terminal event reconciles: the persisted run REPLACES the folded stream', async () => {
  // The store is empty until the terminal event "persists" the run — so the
  // assertions below can ONLY be satisfied by the reconcile fetch, never by
  // the live fold racing ahead of it.
  let stored: PrReviewRun[] = [];
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'list_pr_review_runs') return Promise.resolve(stored);
    if (cmd === 'get_pr_review_run') return Promise.resolve(stored[0] ?? null);
    return Promise.resolve(undefined);
  });
  const api = await mountHook();

  // The live events carry NO prNumber — the folded entry stays invisible to
  // byPr(42) until the authoritative persisted projection replaces it.
  emit({ type: 'pr-review-started', runId: 'run-9', lenses: ['security'], model: 'm' });
  stored = [
    persistedRun({
      id: 'run-9',
      prNumber: 42,
      status: 'completed',
      findings: [storedFinding()],
    }),
  ];
  emit({
    type: 'pr-review-completed',
    runId: 'run-9',
    findings: [
      {
        id: 'w1',
        lens: 'security',
        severity: 'low',
        file: 'src/a.ts',
        title: 'From the wire',
        body: 'b',
        fingerprint: 'fp-w1',
      },
    ],
    lensesRun: 1,
    costUsd: 0.1,
    durationMs: 5,
  });

  await vi.waitFor(() =>
    expect(api().byPr(42).stream?.findings.map((f) => f.title)).toEqual([
      'From the store',
    ]),
  );
  const stream = api().byPr(42).stream!;
  expect(stream.runId).toBe('run-9');
  expect(stream.status).toBe('completed');
  // The persisted list refreshed too — the history now carries the run.
  await vi.waitFor(() =>
    expect(api().byPr(42).history.map((r) => r.id)).toEqual(['run-9']),
  );
});

test('the optimistic start entry never overwrites events that folded during the command window', async () => {
  let resolveStart: (runId: string) => void = () => {};
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'start_pr_review') {
      return new Promise((resolve) => (resolveStart = resolve as (r: string) => void));
    }
    return Promise.resolve([]);
  });
  const api = await mountHook();

  const startPromise = api().start(42, SECURITY);
  // The backend streams ahead of the command resolution: the run's entry is
  // created (and advanced) by live events inside the IPC window.
  emit({ type: 'pr-review-started', runId: 'run-9', lenses: ['security'], model: 'm' });
  emit({
    type: 'pr-review-lens-completed',
    runId: 'run-9',
    lens: 'security',
    findings: [
      {
        id: 'w1',
        lens: 'security',
        severity: 'low',
        file: 'src/a.ts',
        title: 'Raced ahead',
        body: 'b',
        fingerprint: 'fp-w1',
      },
    ],
    costUsd: 0.01,
  });
  await vi.waitFor(() =>
    expect(api().registry.get('run-9')?.stream.findings).toHaveLength(1),
  );

  resolveStart('run-9');
  await expect(startPromise).resolves.toBe('run-9');
  // The folded progress survives — the optimistic seed did not clobber it.
  await new Promise((r) => setTimeout(r, 20));
  expect(api().registry.get('run-9')?.stream.findings.map((f) => f.title)).toEqual([
    'Raced ahead',
  ]);
  expect(api().registry.get('run-9')?.stream.lensState['security']).toBe('done');
});

test('a slow mount list cannot downgrade a terminal stream back to running', async () => {
  const completed = persistedRun({ id: 'run-1', prNumber: 42, status: 'completed' });
  const staleRunning = persistedRun({ id: 'run-1', prNumber: 42, status: 'running' });
  let resolveList: (v: PrReviewRun[]) => void = () => {};
  let listCalls = 0;
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'list_pr_review_runs') {
      listCalls += 1;
      // The MOUNT list parks (a slow read); later refreshes resolve fresh.
      if (listCalls === 1) {
        return new Promise<PrReviewRun[]>((resolve) => (resolveList = resolve));
      }
      return Promise.resolve([completed]);
    }
    if (cmd === 'get_pr_review_run') return Promise.resolve(completed);
    return Promise.resolve(undefined);
  });
  const api = await mountHook();

  // The run completes live while the mount list is still in flight.
  emit({ type: 'pr-review-started', runId: 'run-1', lenses: ['security'], model: 'm' });
  emit({
    type: 'pr-review-completed',
    runId: 'run-1',
    findings: [],
    lensesRun: 1,
    costUsd: 0,
    durationMs: 5,
  });
  await vi.waitFor(() =>
    expect(api().registry.get('run-1')?.stream.status).toBe('completed'),
  );

  // The stale pre-completion snapshot resolves late — replacing the terminal
  // stream would show "running" FOREVER (and disable start()). It must lose.
  resolveList([staleRunning]);
  await new Promise((r) => setTimeout(r, 20));
  expect(api().registry.get('run-1')?.stream.status).toBe('completed');
  expect(api().byPr(42).isRunning).toBe(false);
});

test('mid-run recovery: a remount reprojects the running run and live events keep folding (no drop-gate)', async () => {
  const midRun = persistedRun({
    id: 'run-5',
    prNumber: 7,
    status: 'running',
    lenses: ['logic', 'security'],
    findings: [storedFinding({ id: 'sf-1', fingerprint: 'sf-1' })],
  });
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'list_pr_review_runs') return Promise.resolve([midRun]);
    if (cmd === 'get_pr_review_run') return Promise.resolve(midRun);
    return Promise.resolve(undefined);
  });
  const api = await mountHook();

  // The store projection recovers the accumulated finding + running state.
  await vi.waitFor(() => expect(api().byPr(7).isRunning).toBe(true));
  expect(api().byPr(7).stream?.findings).toHaveLength(1);

  // A live lens event for that runId folds ON TOP of the projection — the
  // registry never drop-gates events on a singleton active run.
  emit({
    type: 'pr-review-lens-completed',
    runId: 'run-5',
    lens: 'security',
    findings: [
      {
        id: 'w2',
        lens: 'security',
        severity: 'medium',
        file: 'src/b.ts',
        title: 'Live after remount',
        body: 'b',
        fingerprint: 'fp-w2',
      },
    ],
    costUsd: 0.01,
  });
  await vi.waitFor(() => expect(api().byPr(7).stream?.findings).toHaveLength(2));
  expect(api().byPr(7).stream?.lensState['security']).toBe('done');
});
