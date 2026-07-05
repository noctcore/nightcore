import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri seams (the prreview-runs.hooks.test.tsx pattern): `invoke` is
// controllable per test, and `listen` captures the channel handler so tests can
// push live `nc:pr-fix` snapshots straight into the registry hook.
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

import type { PrFixState } from '@/lib/bridge';

import { usePrFixes, type UsePrFixesResult } from './prreview-fixes.hooks';

/** Flip the Tauri detection so the bridge's wrappers and the `nc:pr-fix`
 *  subscription reach the mocks instead of no-opping. */
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  listeners.clear();
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function Harness({ sink }: { sink: (api: UsePrFixesResult) => void }) {
  const api = usePrFixes(true);
  useEffect(() => {
    sink(api);
  });
  return null;
}

/** Push one full-state snapshot onto the captured `nc:pr-fix` channel. */
function emit(state: unknown) {
  const handler = listeners.get('nc:pr-fix');
  if (handler === undefined) throw new Error('nc:pr-fix not subscribed');
  handler({ payload: state });
}

function fixState(over: Partial<PrFixState> = {}): PrFixState {
  return {
    id: 'fix-1',
    runId: 'run-1',
    prNumber: 42,
    branch: 'feat/x',
    dir: '/wt',
    status: 'running',
    summary: null,
    error: null,
    findingCount: 2,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

async function mountHook(): Promise<() => UsePrFixesResult> {
  let api: UsePrFixesResult | undefined;
  render(<Harness sink={(a) => (api = a)} />);
  await vi.waitFor(() => {
    expect(api).toBeDefined();
    expect(listeners.has('nc:pr-fix')).toBe(true);
  });
  return () => api!;
}

test('live snapshots fold into the registry; fixForPr returns the latest by updatedAt', async () => {
  invoke.mockImplementation(() => Promise.resolve([]));
  const api = await mountHook();

  emit(fixState());
  await vi.waitFor(() => expect(api().fixForPr(42)?.id).toBe('fix-1'));

  // A newer fix for the SAME PR wins; another PR's fix is untouched.
  emit(fixState({ id: 'fix-2', status: 'pushed', updatedAt: 2000 }));
  emit(fixState({ id: 'fix-other', prNumber: 7, updatedAt: 3000 }));
  await vi.waitFor(() => expect(api().fixForPr(42)?.id).toBe('fix-2'));
  expect(api().fixForPr(42)?.status).toBe('pushed');
  expect(api().fixForPr(7)?.id).toBe('fix-other');
});

test('a malformed snapshot is dropped, never folded', async () => {
  invoke.mockImplementation(() => Promise.resolve([]));
  const api = await mountHook();

  // Missing `status` + non-numeric prNumber: both fail the shape narrower.
  emit({ id: 'fix-bad', prNumber: 42, branch: 'b' });
  emit(fixState({ id: 'fix-ok', updatedAt: 500 }));
  await vi.waitFor(() => expect(api().fixForPr(42)?.id).toBe('fix-ok'));
  expect(api().fixes.has('fix-bad')).toBe(false);
});

test('mount reconcile seeds the registry from list_pr_fixes', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'list_pr_fixes'
      ? Promise.resolve([fixState({ id: 'fix-9', status: 'awaiting_push' })])
      : Promise.resolve(undefined),
  );
  const api = await mountHook();
  await vi.waitFor(() => expect(api().fixForPr(42)?.id).toBe('fix-9'));
  expect(api().fixForPr(42)?.status).toBe('awaiting_push');
});

test('a stale list snapshot cannot downgrade a newer live state', async () => {
  // The list read parks until AFTER a newer live snapshot has folded.
  let resolveList: (v: PrFixState[]) => void = () => {};
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'list_pr_fixes'
      ? new Promise<PrFixState[]>((resolve) => (resolveList = resolve))
      : Promise.resolve(undefined),
  );
  const api = await mountHook();

  emit(fixState({ status: 'awaiting_push', updatedAt: 2000 }));
  await vi.waitFor(() => expect(api().fixForPr(42)?.status).toBe('awaiting_push'));

  // The stale pre-completion snapshot resolves late — updatedAt guards it out.
  resolveList([fixState({ status: 'running', updatedAt: 1000 })]);
  await new Promise((r) => setTimeout(r, 20));
  expect(api().fixForPr(42)?.status).toBe('awaiting_push');
});

test('on an EQUAL updatedAt the further-along status wins (same-ms transition pairs)', async () => {
  invoke.mockImplementation(() => Promise.resolve([]));
  const api = await mountHook();

  // The Rust dispatch-failure path emits running→failed in the SAME ms; here
  // they arrive out of order — the earlier lifecycle stage must not win the tie.
  emit(fixState({ status: 'failed', error: 'dispatch failed', updatedAt: 1000 }));
  await vi.waitFor(() => expect(api().fixForPr(42)?.status).toBe('failed'));
  emit(fixState({ status: 'running', updatedAt: 1000 }));
  await new Promise((r) => setTimeout(r, 20));
  expect(api().fixForPr(42)?.status).toBe('failed');

  // In arrival order the same-ms pair still settles on the further-along state.
  emit(fixState({ id: 'fix-2', status: 'committing', updatedAt: 2000 }));
  await vi.waitFor(() => expect(api().fixes.get('fix-2')?.status).toBe('committing'));
  emit(fixState({ id: 'fix-2', status: 'awaiting_push', updatedAt: 2000 }));
  await vi.waitFor(() =>
    expect(api().fixes.get('fix-2')?.status).toBe('awaiting_push'),
  );
});

test('a snapshot with an UNKNOWN future status still folds (forward-compatible narrower)', async () => {
  invoke.mockImplementation(() => Promise.resolve([]));
  const api = await mountHook();

  // The event narrower accepts any string status (the list path never narrows
  // either) — a newer backend's status must not be dropped on the floor.
  emit(fixState({ status: 'archived-v2', updatedAt: 1000 }));
  await vi.waitFor(() => expect(api().fixForPr(42)?.status).toBe('archived-v2'));
});

test('double-address of the SAME PR is guarded; DIFFERENT PRs address concurrently', async () => {
  const resolvers: Array<(fixId: string) => void> = [];
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'address_review_findings') {
      return new Promise((resolve) => resolvers.push(resolve as (f: string) => void));
    }
    return Promise.resolve([]);
  });
  const api = await mountHook();

  // Two synchronous clicks on PR 42 + one on PR 7, all inside the IPC gap.
  const first = api().address(42, 'run-1', ['f1']);
  const second = api().address(42, 'run-1', ['f1']);
  const other = api().address(7, 'run-2', ['f2']);

  await expect(second).resolves.toEqual({ fixId: null, error: null });
  expect(
    invoke.mock.calls.filter((c) => c[0] === 'address_review_findings'),
  ).toHaveLength(2);

  resolvers[0]!('fix-42');
  resolvers[1]!('fix-7');
  await expect(first).resolves.toEqual({ fixId: 'fix-42', error: null });
  await expect(other).resolves.toEqual({ fixId: 'fix-7', error: null });
});

test('address refuses while a fix is already running for the PR', async () => {
  invoke.mockImplementation(() => Promise.resolve([]));
  const api = await mountHook();

  emit(fixState({ status: 'running' }));
  await vi.waitFor(() => expect(api().fixForPr(42)?.status).toBe('running'));

  await expect(api().address(42, 'run-1', ['f1'])).resolves.toEqual({
    fixId: null,
    error: null,
  });
  expect(
    invoke.mock.calls.filter((c) => c[0] === 'address_review_findings'),
  ).toHaveLength(0);
});

test('an empty selection never starts a fix', async () => {
  invoke.mockImplementation(() => Promise.resolve([]));
  const api = await mountHook();

  await expect(api().address(42, 'run-1', [])).resolves.toEqual({
    fixId: null,
    error: null,
  });
  expect(
    invoke.mock.calls.filter((c) => c[0] === 'address_review_findings'),
  ).toHaveLength(0);
});

test('a rejected address records a per-PR fixError AND plumbs the message; the next success clears it', async () => {
  let fail = true;
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'address_review_findings') {
      return fail
        ? Promise.reject(new Error('the PR head is on a fork'))
        : Promise.resolve('fix-1');
    }
    return Promise.resolve([]);
  });
  const api = await mountHook();

  // The rejection message rides in the resolved outcome (so the caller can
  // toast synchronously) besides landing in the per-PR fixErrors map.
  await expect(api().address(42, 'run-1', ['f1'])).resolves.toEqual({
    fixId: null,
    error: 'the PR head is on a fork',
  });
  await vi.waitFor(() =>
    expect(api().fixErrors.get(42)).toBe('the PR head is on a fork'),
  );

  fail = false;
  await expect(api().address(42, 'run-1', ['f1'])).resolves.toEqual({
    fixId: 'fix-1',
    error: null,
  });
  await vi.waitFor(() => expect(api().fixErrors.has(42)).toBe(false));
});

test('dismiss hides the latest failed fix without resurfacing an older one', async () => {
  invoke.mockImplementation(() => Promise.resolve([]));
  const api = await mountHook();

  emit(fixState({ id: 'fix-old', status: 'pushed', updatedAt: 1000 }));
  emit(fixState({ id: 'fix-new', status: 'failed', error: 'boom', updatedAt: 2000 }));
  await vi.waitFor(() => expect(api().fixForPr(42)?.id).toBe('fix-new'));

  api().dismiss('fix-new');
  await vi.waitFor(() => expect(api().fixForPr(42)).toBeNull());

  // A NEW fix for the same PR shows normally under its new id.
  emit(fixState({ id: 'fix-next', status: 'running', updatedAt: 3000 }));
  await vi.waitFor(() => expect(api().fixForPr(42)?.id).toBe('fix-next'));
});

test('push and cancel invoke their commands with the fix id', async () => {
  invoke.mockImplementation(() => Promise.resolve([]));
  const api = await mountHook();

  await api().push('fix-1');
  expect(invoke).toHaveBeenCalledWith('push_pr_fix', { fixId: 'fix-1' });

  await api().cancel('fix-2');
  expect(invoke).toHaveBeenCalledWith('cancel_pr_fix', { fixId: 'fix-2' });
});
