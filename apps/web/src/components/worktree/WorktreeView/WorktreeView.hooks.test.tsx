import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { ToastProvider } from '@/components/ui';
import type { Task, WorktreeInfo } from '@/lib/bridge';

// Mock the bridge so the terminal-session gating (terminal spec, decision 2) is
// fully controllable: sessions-in-dir returns one open session, and kill/discard/
// merge are observable spies.
const killTerminal = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
const discardWorktree = vi.fn(() => Promise.resolve());
const mergeTask = vi.fn(() => Promise.resolve());
const mergePreview = vi.fn(() =>
  Promise.resolve({
    status: 'diverged',
    branch: 'nc/t1',
    base: 'main',
    conflictFiles: [],
    files: [],
    additions: 0,
    deletions: 0,
    ahead: 1,
    behind: 2,
  }),
);
const updateWorktreeFromBase = vi.fn<(id: string) => Promise<'up_to_date' | 'updated' | 'conflict'>>(
  () => Promise.resolve('updated'),
);
const terminalSessionsInDir = vi.fn(() =>
  Promise.resolve([
    {
      id: 's1',
      cwd: '/wt/t1',
      shell: '/bin/zsh',
      confined: false,
      cols: 80,
      rows: 24,
      alive: true,
      createdAt: 0,
    },
  ]),
);
// Partial mock (spread the real bridge) so co-loaded modules keep every other
// export; only the merge/discard + update-from-base + terminal seam is controlled.
vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    discardWorktree: () => discardWorktree(),
    killTerminal: (id: string) => killTerminal(id),
    mergeTask: () => mergeTask(),
    mergePreview: () => mergePreview(),
    updateWorktreeFromBase: (id: string) => updateWorktreeFromBase(id),
    terminalSessionsInDir: () => terminalSessionsInDir(),
  };
});

import { useWorktreeView, type WorktreeViewModel } from './WorktreeView.hooks';

const WORKTREES: WorktreeInfo[] = [
  {
    branch: 'nc/t1',
    path: '/wt/t1',
    taskIds: ['t1'],
    dirty: false,
    aheadOfBase: 1,
    behindOfBase: 0,
    changedFiles: 0,
  },
];
const TASKS = [{ id: 't1', title: 'T1', branch: 'nc/t1' }] as unknown as Task[];

function Harness({ modelRef }: { modelRef: { current: WorktreeViewModel | null } }) {
  modelRef.current = useWorktreeView(TASKS, WORKTREES);
  return null;
}

function renderHook() {
  const modelRef: { current: WorktreeViewModel | null } = { current: null };
  render(
    <ToastProvider>
      <Harness modelRef={modelRef} />
    </ToastProvider>,
  );
  return modelRef;
}

afterEach(() => {
  killTerminal.mockClear();
  discardWorktree.mockClear();
  mergeTask.mockClear();
  mergePreview.mockClear();
  updateWorktreeFromBase.mockClear();
  terminalSessionsInDir.mockClear();
});

test('discard confirm kills the worktree terminal sessions BEFORE discarding', async () => {
  const model = renderHook();
  model.current!.openDiscard('t1');

  // The discard flow probes for open sessions in the worktree.
  await vi.waitFor(() => expect(terminalSessionsInDir).toHaveBeenCalled());
  await vi.waitFor(() => expect(model.current!.discard?.terminalSessions).toEqual(['s1']));

  model.current!.confirmDiscard();

  await vi.waitFor(() => expect(killTerminal).toHaveBeenCalledWith('s1'));
  await vi.waitFor(() => expect(discardWorktree).toHaveBeenCalled());
  // Kill happens before the discard proceeds.
  expect(killTerminal.mock.invocationCallOrder[0]!).toBeLessThan(
    discardWorktree.mock.invocationCallOrder[0]!,
  );
});

test('merge confirm kills the worktree terminal sessions BEFORE merging', async () => {
  const model = renderHook();
  model.current!.openPreview('t1');

  await vi.waitFor(() => expect(model.current!.preview?.terminalSessions).toEqual(['s1']));

  model.current!.confirmMerge();

  await vi.waitFor(() => expect(killTerminal).toHaveBeenCalledWith('s1'));
  await vi.waitFor(() => expect(mergeTask).toHaveBeenCalled());
  expect(killTerminal.mock.invocationCallOrder[0]!).toBeLessThan(
    mergeTask.mock.invocationCallOrder[0]!,
  );
});

test('with no open sessions, discard proceeds without killing anything', async () => {
  terminalSessionsInDir.mockResolvedValueOnce([]);
  const model = renderHook();
  model.current!.openDiscard('t1');

  await vi.waitFor(() => expect(model.current!.discard?.terminalSessions).toEqual([]));
  model.current!.confirmDiscard();

  await vi.waitFor(() => expect(discardWorktree).toHaveBeenCalled());
  expect(killTerminal).not.toHaveBeenCalled();
});

test('update from base pulls base into the worktree and refreshes the preview', async () => {
  const model = renderHook();
  model.current!.openPreview('t1');
  await vi.waitFor(() => expect(mergePreview).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(model.current!.preview?.data?.behind).toBe(2));

  model.current!.updateFromBase();

  await vi.waitFor(() => expect(updateWorktreeFromBase).toHaveBeenCalledWith('t1'));
  // 'updated' refreshes the open preview in place — mergePreview runs a 2nd time.
  await vi.waitFor(() => expect(mergePreview).toHaveBeenCalledTimes(2));
});

test('an up-to-date update-from-base does not refresh the preview', async () => {
  updateWorktreeFromBase.mockResolvedValueOnce('up_to_date');
  const model = renderHook();
  model.current!.openPreview('t1');
  await vi.waitFor(() => expect(mergePreview).toHaveBeenCalledTimes(1));
  // Wait for the preview DATA to settle (not just non-null — `undefined` also
  // passes `not.toBeNull`) so `updateFromBase` closes over a non-null preview; a
  // stale closure would early-return before ever reaching the bridge call.
  await vi.waitFor(() => expect(model.current!.preview?.data?.behind).toBe(2));

  model.current!.updateFromBase();
  await vi.waitFor(() => expect(updateWorktreeFromBase).toHaveBeenCalled());
  await vi.waitFor(() => expect(model.current!.updatingFromBase).toBe(false));
  // No state change on the base ⇒ no in-place refetch.
  expect(mergePreview).toHaveBeenCalledTimes(1);
});
