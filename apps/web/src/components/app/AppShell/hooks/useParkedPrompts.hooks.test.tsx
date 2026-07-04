import { useEffect } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the bridge seam: capture the `nc:permission` subscriber so tests can push
// prompts, and make `respond_permission` controllable (resolve vs reject) to
// exercise the optimistic-remove / re-insert-on-failure branch.
let permissionHandler: ((prompt: PermissionPrompt) => void) | undefined;
const onPermissionEvent = vi.fn((h: (p: PermissionPrompt) => void) => {
  permissionHandler = h;
  return Promise.resolve(() => {});
});
const respondPermission = vi.fn<() => Promise<void>>();
vi.mock('@/lib/bridge', () => ({
  onPermissionEvent: (h: (p: PermissionPrompt) => void) => onPermissionEvent(h),
  onQuestionEvent: () => Promise.resolve(() => {}),
  respondPermission: () => respondPermission(),
  answerQuestion: () => Promise.resolve(),
}));

import type { ToastApi } from '@/components/ui';
import type { PermissionPrompt, Task } from '@/lib/bridge';

import { usePermissions } from './useParkedPrompts.hooks';

afterEach(() => {
  onPermissionEvent.mockClear();
  respondPermission.mockReset();
  permissionHandler = undefined;
});

function fakeToast(): ToastApi {
  return { toasts: [], push: vi.fn(() => 1), error: vi.fn(() => 1), dismiss: vi.fn() };
}

/** A minimal in-progress task (only `id`/`status` are read by the prune effect). */
function liveTask(id: string): Task {
  return { id, status: 'in_progress' } as Task;
}

function prompt(taskId: string, requestId: string): PermissionPrompt {
  return { taskId, requestId, toolName: 'Bash', input: {} };
}

type Controller = ReturnType<typeof usePermissions>;

/** Render `usePermissions` with a controllable task list and report its state. */
function Harness({ tasks, toast, sink }: { tasks: Task[]; toast: ToastApi; sink: (c: Controller) => void }) {
  const controller = usePermissions(tasks, toast);
  useEffect(() => {
    sink(controller);
  });
  return null;
}

async function mount(tasks: Task[], toast: ToastApi): Promise<{ get: () => Controller; rerender: (tasks: Task[]) => void }> {
  let latest: Controller | undefined;
  const view = render(<Harness tasks={tasks} toast={toast} sink={(c) => (latest = c)} />);
  await vi.waitFor(() => expect(latest).toBeDefined());
  await vi.waitFor(() => expect(permissionHandler).toBeDefined());
  return {
    get: () => latest!,
    rerender: (next) => view.rerender(<Harness tasks={next} toast={toast} sink={(c) => (latest = c)} />),
  };
}

test('groups an incoming prompt by task id and dedups a repeat request id', async () => {
  const toast = fakeToast();
  const { get } = await mount([liveTask('t1')], toast);

  permissionHandler!(prompt('t1', 'r1'));
  await vi.waitFor(() => expect(get().prompts['t1']?.length).toBe(1));

  // A duplicate requestId is dropped rather than double-parked.
  permissionHandler!(prompt('t1', 'r1'));
  await new Promise((r) => setTimeout(r, 20));
  expect(get().prompts['t1']?.length).toBe(1);
});

test('prunes prompts for a task that is no longer live', async () => {
  const toast = fakeToast();
  const { get, rerender } = await mount([liveTask('t1')], toast);

  permissionHandler!(prompt('t1', 'r1'));
  await vi.waitFor(() => expect(get().prompts['t1']?.length).toBe(1));

  // The task drops out of the live set — its parked prompt is pruned.
  rerender([{ id: 't1', status: 'done' } as Task]);
  await vi.waitFor(() => expect(get().prompts['t1']).toBeUndefined());
});

test('respond removes the prompt optimistically on success', async () => {
  respondPermission.mockResolvedValue(undefined);
  const toast = fakeToast();
  const { get } = await mount([liveTask('t1')], toast);

  permissionHandler!(prompt('t1', 'r1'));
  await vi.waitFor(() => expect(get().prompts['t1']?.length).toBe(1));

  get().respond('t1', 'r1', 'allow');
  await vi.waitFor(() => expect(get().prompts['t1']).toBeUndefined());
  expect(respondPermission).toHaveBeenCalledTimes(1);
  expect(toast.error).not.toHaveBeenCalled();
});

test('respond re-inserts the prompt and toasts when the relay fails', async () => {
  // Reject on a macrotask (as a real IPC relay does) so the optimistic-removal
  // state flush lands first and the handler captures the prompt to re-insert.
  respondPermission.mockImplementation(
    () => new Promise((_, reject) => setTimeout(() => reject(new Error('engine dialog gone')), 0)),
  );
  const toast = fakeToast();
  const { get } = await mount([liveTask('t1')], toast);

  permissionHandler!(prompt('t1', 'r1'));
  await vi.waitFor(() => expect(get().prompts['t1']?.length).toBe(1));

  get().respond('t1', 'r1', 'allow');
  // Optimistically dropped, then re-inserted once the relay rejects — the user
  // can retry instead of the run hanging on a prompt the UI already removed.
  await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not answer the permission prompt', expect.anything()));
  await vi.waitFor(() => expect(get().prompts['t1']?.length).toBe(1));
});
