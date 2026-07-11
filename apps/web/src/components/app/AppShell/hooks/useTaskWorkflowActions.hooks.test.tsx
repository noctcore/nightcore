import { useEffect } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the bridge seam so the two toast-on-success git-op gates (commit/merge)
// are controllable per test: resolve → success toast, reject → error toast, a
// never-settling promise keeps the guard key pending for the single-flight check.
// The remaining workflow commands the hook imports are stubbed to a resolved
// no-op — this suite only exercises commit/merge (the toast-wired handlers).
const commitTask = vi.fn<(id: string) => Promise<void>>();
const mergeTask = vi.fn<(id: string) => Promise<void>>();
vi.mock('@/lib/bridge', () => ({
  approveTask: () => Promise.resolve(),
  rejectTask: () => Promise.resolve(),
  refineTask: () => Promise.resolve(),
  commitTask: (id: string) => commitTask(id),
  mergeTask: (id: string) => mergeTask(id),
  acceptReview: () => Promise.resolve(),
  rejectReview: () => Promise.resolve(),
  rerunVerification: () => Promise.resolve(),
  convertSubtask: () => Promise.resolve(),
  convertAllSubtasks: () => Promise.resolve(),
}));

import type { ToastApi } from '@/components/ui';

import { type ActionGuard, useActionGuard } from './useActionGuard.hooks';
import { type TaskWorkflowActions, useTaskWorkflowActions } from './useTaskWorkflowActions.hooks';

afterEach(() => {
  commitTask.mockReset();
  mergeTask.mockReset();
});

function fakeToast(): ToastApi {
  return { toasts: [], push: vi.fn(() => 1), error: vi.fn(() => 1), dismiss: vi.fn() };
}

interface Mounted {
  actions: TaskWorkflowActions;
  action: ActionGuard;
}

/** Render `useTaskWorkflowActions` over a real action guard and report both the
 *  action layer and the live guard (so a test can await the pending transition). */
function Harness({ toast, sink }: { toast: ToastApi; sink: (m: Mounted) => void }) {
  const action = useActionGuard();
  const actions = useTaskWorkflowActions({ action, toast });
  useEffect(() => {
    sink({ actions, action });
  });
  return null;
}

async function mount(toast: ToastApi): Promise<() => Mounted> {
  let latest: Mounted | undefined;
  render(<Harness toast={toast} sink={(m) => (latest = m)} />);
  await vi.waitFor(() => expect(latest).toBeDefined());
  return () => latest!;
}

test('handleCommit toasts success when the worktree commit resolves', async () => {
  commitTask.mockResolvedValue(undefined);
  const toast = fakeToast();
  const get = await mount(toast);

  get().actions.handleCommit('t1');
  await vi.waitFor(() =>
    expect(toast.push).toHaveBeenCalledWith({ tone: 'success', title: 'Changes committed' }),
  );
  expect(commitTask).toHaveBeenCalledWith('t1');
  expect(toast.error).not.toHaveBeenCalled();
});

test('handleMerge toasts success when the merge resolves', async () => {
  mergeTask.mockResolvedValue(undefined);
  const toast = fakeToast();
  const get = await mount(toast);

  get().actions.handleMerge('t1');
  await vi.waitFor(() =>
    expect(toast.push).toHaveBeenCalledWith({ tone: 'success', title: 'Branch merged into base' }),
  );
  expect(mergeTask).toHaveBeenCalledWith('t1');
  expect(toast.error).not.toHaveBeenCalled();
});

test('a rejected commit fires the error toast without throwing out of the handler', async () => {
  commitTask.mockRejectedValue(new Error('nothing staged'));
  const toast = fakeToast();
  const get = await mount(toast);

  // The handler returns void and swallows the rejection through the guard — a
  // throw here would escape into the click handler and blank the board.
  expect(() => get().actions.handleCommit('t1')).not.toThrow();
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('Could not commit the worktree', expect.anything()),
  );
  expect(toast.push).not.toHaveBeenCalled();
});

test('an in-flight commit is single-flighted through the guard pending set', async () => {
  // A never-settling command keeps `commit:t1` pending: the guard flips
  // `isPending('commit', 't1')` → true, which is the signal that disables the
  // footer button so a second click can't reach the backend while the first is
  // in flight. The pending key is scoped to the acted action:id.
  commitTask.mockReturnValue(new Promise<void>(() => {}));
  const toast = fakeToast();
  const get = await mount(toast);

  expect(get().action.isPending('commit', 't1')).toBe(false);
  get().actions.handleCommit('t1');

  await vi.waitFor(() => expect(get().action.isPending('commit', 't1')).toBe(true));
  expect(commitTask).toHaveBeenCalledTimes(1);
  // The guard key is exact — an unrelated id/action stays clickable.
  expect(get().action.isPending('commit', 't2')).toBe(false);
  expect(get().action.isPending('merge', 't1')).toBe(false);
});
