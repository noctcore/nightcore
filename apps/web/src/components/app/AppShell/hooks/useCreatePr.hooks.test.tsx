import { useEffect } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri command seam under the bridge (the CreatePRDialog.test.tsx
// pattern) so `createPrTask` is controllable per test.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import type { ToastApi } from '@/components/ui';

import { useActionGuard } from './useActionGuard.hooks';
import { type CreatePrController, useCreatePr } from './useCreatePr.hooks';

/** Render `useCreatePr` over a real action guard and report the controller. */
function Harness({ toast, sink }: { toast: ToastApi; sink: (c: CreatePrController) => void }) {
  const action = useActionGuard();
  const createPr = useCreatePr(action, toast);
  useEffect(() => {
    sink(createPr);
  });
  return null;
}

function fakeToast(): ToastApi {
  return { toasts: [], push: vi.fn(() => 1), error: vi.fn(() => 1), dismiss: vi.fn() };
}

test('a create failure fires an error toast even when no dialog is listening', async () => {
  // The dismissed-mid-submit shape: the dialog that would render the inline
  // error is gone, so the rejection alone would leave the failure invisible.
  // The controller must ALSO toast (the sibling failure-toast pattern).
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'create_pr_task'
      ? Promise.reject(new Error('gh: authentication required'))
      : Promise.resolve(undefined),
  );
  const toast = fakeToast();
  let controller: CreatePrController | undefined;
  render(
    <Harness
      toast={toast}
      sink={(c) => {
        controller = c;
      }}
    />,
  );
  await vi.waitFor(() => expect(controller).toBeDefined());

  await expect(
    controller!.create('t-pr', { title: 't', body: 'b', draft: false }),
  ).rejects.toThrow('gh: authentication required');
  expect(toast.error).toHaveBeenCalledWith(
    'Could not create the pull request',
    expect.anything(),
  );
});

test('a successful create toasts success and does not fire the error toast', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'list_tasks' ? Promise.resolve([]) : Promise.resolve(undefined),
  );
  const toast = fakeToast();
  let controller: CreatePrController | undefined;
  render(
    <Harness
      toast={toast}
      sink={(c) => {
        controller = c;
      }}
    />,
  );
  await vi.waitFor(() => expect(controller).toBeDefined());

  await controller!.create('t-pr', { title: 't', body: 'b', draft: false });
  expect(toast.push).toHaveBeenCalledWith(
    expect.objectContaining({ tone: 'success' }),
  );
  expect(toast.error).not.toHaveBeenCalled();
});
