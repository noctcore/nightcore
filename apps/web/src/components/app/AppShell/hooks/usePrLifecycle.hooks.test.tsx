import { useEffect } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri command seam under the bridge (the useCreatePr.hooks.test
// pattern) so the three PR-lifecycle commands are controllable per test.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import type { ToastApi } from '@/components/ui';

import { useActionGuard } from './useActionGuard.hooks';
import { type PrLifecycleController, usePrLifecycle } from './usePrLifecycle.hooks';

/** Render `usePrLifecycle` over a real action guard and report the controller. */
function Harness({
  toast,
  sink,
}: {
  toast: ToastApi;
  sink: (c: PrLifecycleController) => void;
}) {
  const action = useActionGuard();
  const pr = usePrLifecycle(action, toast);
  useEffect(() => {
    sink(pr);
  });
  return null;
}

function fakeToast(): ToastApi {
  return { toasts: [], push: vi.fn(() => 1), error: vi.fn(() => 1), dismiss: vi.fn() };
}

async function mountController(toast: ToastApi): Promise<PrLifecycleController> {
  let controller: PrLifecycleController | undefined;
  render(
    <Harness
      toast={toast}
      sink={(c) => {
        controller = c;
      }}
    />,
  );
  await vi.waitFor(() => expect(controller).toBeDefined());
  return controller!;
}

test('a push failure fires the error toast and rejects', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'push_pr_updates'
      ? Promise.reject(new Error('remote rejected the push'))
      : Promise.resolve(undefined),
  );
  const toast = fakeToast();
  const controller = await mountController(toast);

  await expect(controller.pushUpdates('t-pr')).rejects.toThrow('remote rejected the push');
  expect(toast.error).toHaveBeenCalledWith('Could not push the updates', expect.anything());
});

test('a successful push toasts success and resolves (the card refetches after)', async () => {
  invoke.mockImplementation(() => Promise.resolve(undefined));
  const toast = fakeToast();
  const controller = await mountController(toast);

  await controller.pushUpdates('t-pr');
  expect(invoke).toHaveBeenCalledWith('push_pr_updates', { id: 't-pr' });
  expect(toast.push).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
  expect(toast.error).not.toHaveBeenCalled();
});

test('a successful finalize toasts success', async () => {
  invoke.mockImplementation(() => Promise.resolve(undefined));
  const toast = fakeToast();
  const controller = await mountController(toast);

  await controller.finalize('t-pr');
  expect(invoke).toHaveBeenCalledWith('finalize_merged_pr', { id: 't-pr' });
  expect(toast.push).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
});

test('a pull-base refusal surfaces the backend message verbatim in the toast', async () => {
  // Tauri command rejections arrive as plain strings; the toast's detail
  // coercion must carry the refusal through verbatim (dirty root / non-ff).
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'pull_base_ff'
      ? Promise.reject('the project root has uncommitted changes')
      : Promise.resolve(undefined),
  );
  const toast = fakeToast();
  const controller = await mountController(toast);

  await expect(controller.pullBase('t-pr')).rejects.toThrow(
    'the project root has uncommitted changes',
  );
  expect(toast.error).toHaveBeenCalledWith(
    'Could not update the base branch',
    'the project root has uncommitted changes',
  );
});
