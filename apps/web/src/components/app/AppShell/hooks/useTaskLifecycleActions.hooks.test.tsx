import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the bridge seam over the REAL module (AppShell.test idiom): keep every
// command real except the three whose rejection drives an optimistic rollback —
// delete/move/update — so each test can resolve or reject them at will. The
// lazy arrows defer to the hoisted spies, initialized by the time they fire.
const deleteTask = vi.fn<(id: string) => Promise<void>>();
const moveTask = vi.fn<(id: string, status: string) => Promise<void>>();
const updateTask = vi.fn<(id: string, patch: unknown) => Promise<unknown>>();
vi.mock('@/lib/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bridge')>();
  return {
    ...actual,
    deleteTask: (id: string) => deleteTask(id),
    moveTask: (id: string, status: string) => moveTask(id, status),
    updateTask: (id: string, patch: unknown) => updateTask(id, patch),
  };
});

import type { TaskTranscript } from '@/components/board';
import { makeTask } from '@/components/board/_fixtures';
import type { ToastApi } from '@/components/ui';
import type { Task } from '@/lib/bridge';

import { useActionGuard } from './useActionGuard.hooks';
import { type TaskLifecycleActions, useTaskLifecycleActions } from './useTaskLifecycleActions.hooks';

afterEach(() => {
  deleteTask.mockReset();
  moveTask.mockReset();
  updateTask.mockReset();
});

function fakeToast(): ToastApi {
  return { toasts: [], push: vi.fn(() => 1), error: vi.fn(() => 1), dismiss: vi.fn() };
}

interface Mounted {
  actions: TaskLifecycleActions;
  tasks: Task[];
  selectedId: string | null;
  setTasks: Dispatch<SetStateAction<Task[]>>;
}

/** Render `useTaskLifecycleActions` over REAL board state (useState-backed) so an
 *  optimistic mutation + rollback is observable, and report the live snapshot. */
function Harness({
  initialTasks,
  initialSelected,
  toast,
  sink,
}: {
  initialTasks: Task[];
  initialSelected: string | null;
  toast: ToastApi;
  sink: (m: Mounted) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [streams, setStreams] = useState<Record<string, TaskTranscript>>({});
  const [selectedId, setSelectedId] = useState<string | null>(initialSelected);
  const action = useActionGuard();
  const board = { tasks, setTasks, streams, setStreams, selectedId, setSelectedId, reseed: () => {} };
  const actions = useTaskLifecycleActions({ board, action, toast });
  useEffect(() => {
    sink({ actions, tasks, selectedId, setTasks });
  });
  return null;
}

async function mount(
  initialTasks: Task[],
  initialSelected: string | null,
  toast: ToastApi,
): Promise<() => Mounted> {
  let latest: Mounted | undefined;
  render(
    <Harness
      initialTasks={initialTasks}
      initialSelected={initialSelected}
      toast={toast}
      sink={(m) => (latest = m)}
    />,
  );
  await vi.waitFor(() => expect(latest).toBeDefined());
  return () => latest!;
}

const ids = (tasks: Task[]): string[] => tasks.map((t) => t.id);

/** A promise whose settlement the test drives, so a rejection lands only AFTER
 *  the optimistic render has committed — mirroring a real IPC round-trip (a
 *  macrotask), not the microtask a bare `mockRejectedValue` rejects on (which
 *  would race ahead of React's deferred optimistic render). */
function deferred<T = void>(): { promise: Promise<T>; reject: (reason: unknown) => void } {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

test('handleDelete rollback restores the task at its original index and re-selects it', async () => {
  const pending = deferred();
  deleteTask.mockReturnValue(pending.promise);
  const toast = fakeToast();
  const get = await mount(
    [makeTask({ id: 't0' }), makeTask({ id: 't1' }), makeTask({ id: 't2' })],
    't1',
    toast,
  );

  get().actions.handleDelete('t1');
  // Let the optimistic drop commit first: t1 removed and the selection cleared.
  await vi.waitFor(() => expect(ids(get().tasks)).toEqual(['t0', 't2']));
  await vi.waitFor(() => expect(get().selectedId).toBeNull());

  pending.reject(new Error('store is locked'));
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('Could not delete task', expect.anything()),
  );
  // The rejected delete re-inserts t1 back at index 1 (not appended) and
  // re-selects it because it was selected when it was optimistically dropped.
  await vi.waitFor(() => expect(ids(get().tasks)).toEqual(['t0', 't1', 't2']));
  await vi.waitFor(() => expect(get().selectedId).toBe('t1'));
});

test('a nc:task echo re-adding the task during rollback does not duplicate it', async () => {
  const pending = deferred();
  deleteTask.mockReturnValue(pending.promise);
  const toast = fakeToast();
  const get = await mount([makeTask({ id: 't0' }), makeTask({ id: 't1' })], null, toast);

  get().actions.handleDelete('t1');
  await vi.waitFor(() => expect(ids(get().tasks)).toEqual(['t0']));

  // Simulate the authoritative `nc:task` echo re-adding t1 while the delete is
  // still in flight (useBoard's onTaskEvent path).
  get().setTasks((prev) => (prev.some((t) => t.id === 't1') ? prev : [...prev, makeTask({ id: 't1' })]));
  await vi.waitFor(() => expect(get().tasks.filter((t) => t.id === 't1')).toHaveLength(1));

  // Now the delete rejects → rollback runs, sees t1 already present, and must
  // NOT insert a duplicate.
  pending.reject(new Error('gone'));
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 20));
  expect(get().tasks.filter((t) => t.id === 't1')).toHaveLength(1);
});

test('handleMoveTask skips the optimistic retag for in-flight (in_progress/verifying) tasks', async () => {
  // The move is refused; an in-flight task must neither be optimistically retagged
  // nor rolled back — its status is owned by the live run's `nc:task` stream.
  moveTask.mockRejectedValue(new Error('backend refuses an in-flight move'));
  const toast = fakeToast();
  const get = await mount(
    [makeTask({ id: 't1', status: 'in_progress' }), makeTask({ id: 't2', status: 'verifying' })],
    null,
    toast,
  );

  get().actions.handleMoveTask('t1', 'done');
  get().actions.handleMoveTask('t2', 'done');

  await vi.waitFor(() => expect(moveTask).toHaveBeenCalledTimes(2));
  await new Promise((r) => setTimeout(r, 20));
  expect(get().tasks.find((t) => t.id === 't1')?.status).toBe('in_progress');
  expect(get().tasks.find((t) => t.id === 't2')?.status).toBe('verifying');
});

test('handleMoveTask rolls back the status on rejection for a non-in-flight task', async () => {
  moveTask.mockRejectedValue(new Error('non-fast-forward'));
  const toast = fakeToast();
  const get = await mount([makeTask({ id: 't1', status: 'backlog' })], null, toast);

  get().actions.handleMoveTask('t1', 'done');

  // The optimistic retag reached the backend as `done`...
  await vi.waitFor(() => expect(moveTask).toHaveBeenCalledWith('t1', 'done'));
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('Could not move task', expect.anything()),
  );
  // ...then the rejection rolls the card back to its prior column.
  await vi.waitFor(() => expect(get().tasks[0]?.status).toBe('backlog'));
});

test('makeFieldUpdater rolls back to the prior value when the update rejects', async () => {
  updateTask.mockRejectedValue(new Error('store rejected the patch'));
  const toast = fakeToast();
  const get = await mount([makeTask({ id: 't1', title: 'old title' })], null, toast);

  // handleChangeTitle is a makeFieldUpdater('title') instance.
  get().actions.handleChangeTitle('t1', 'new title');

  await vi.waitFor(() => expect(updateTask).toHaveBeenCalledWith('t1', { title: 'new title' }));
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('Could not update task', expect.anything()),
  );
  await vi.waitFor(() => expect(get().tasks[0]?.title).toBe('old title'));
});

test('handleClearColumn rolls back only the tasks whose delete failed', async () => {
  // t1's delete rejects, t2's resolves — a partial bulk-clear failure must
  // re-insert only t1 and leave t2 gone (and the untargeted t3 untouched).
  deleteTask.mockImplementation((id: string) =>
    id === 't1' ? Promise.reject(new Error('locked')) : Promise.resolve(),
  );
  const toast = fakeToast();
  const get = await mount(
    [
      makeTask({ id: 't1', status: 'done' }),
      makeTask({ id: 't2', status: 'done' }),
      makeTask({ id: 't3', status: 'backlog' }),
    ],
    null,
    toast,
  );

  get().actions.handleClearColumn(['done']);

  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('Could not delete task', expect.anything()),
  );
  // Only the two `done` tasks were targeted; t1 is restored (at its index),
  // t2 stays deleted, t3 was never touched.
  await vi.waitFor(() => expect(ids(get().tasks)).toEqual(['t1', 't3']));
  expect(deleteTask).toHaveBeenCalledTimes(2);
});
