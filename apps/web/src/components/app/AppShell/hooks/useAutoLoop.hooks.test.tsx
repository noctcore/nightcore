import { useEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri command seam under the bridge so `set_max_concurrency_cmd` is
// controllable per test. `tauriInvoke` no-ops outside the webview, so the tests
// stub `window.__TAURI_INTERNALS__` to make the wrapper actually invoke.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invoke.mockReset();
});

import type { ToastApi } from '@/components/ui';

import { useAutoLoop } from './useAutoLoop.hooks';

type Controller = ReturnType<typeof useAutoLoop>;

/** Render `useAutoLoop` and report its controller to the test. */
function Harness({
  persist,
  toast,
  sink,
}: {
  persist: (n: number) => void;
  toast: ToastApi;
  sink: (c: Controller) => void;
}) {
  const loop = useAutoLoop(3, persist, toast);
  useEffect(() => {
    sink(loop);
  });
  return null;
}

function fakeToast(): ToastApi {
  return { toasts: [], push: vi.fn(() => 1), error: vi.fn(() => 1), dismiss: vi.fn() };
}

test('changeConcurrency persists only after the backend accepts', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'set_max_concurrency_cmd' ? Promise.resolve(undefined) : Promise.resolve(undefined),
  );
  const persist = vi.fn();
  const toast = fakeToast();
  let controller: Controller | undefined;
  render(
    <Harness
      persist={persist}
      toast={toast}
      sink={(c) => {
        controller = c;
      }}
    />,
  );
  await vi.waitFor(() => expect(controller).toBeDefined());

  controller!.changeConcurrency(5);
  await vi.waitFor(() => expect(persist).toHaveBeenCalledWith(5));
  expect(toast.error).not.toHaveBeenCalled();
});

test('a rejected set_max_concurrency does NOT persist the new value', async () => {
  invoke.mockImplementation((cmd: unknown) =>
    cmd === 'set_max_concurrency_cmd'
      ? Promise.reject(new Error('pool refused'))
      : Promise.resolve(undefined),
  );
  const persist = vi.fn();
  const toast = fakeToast();
  let controller: Controller | undefined;
  render(
    <Harness
      persist={persist}
      toast={toast}
      sink={(c) => {
        controller = c;
      }}
    />,
  );
  await vi.waitFor(() => expect(controller).toBeDefined());

  controller!.changeConcurrency(5);
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('Could not change concurrency', expect.anything()),
  );
  expect(persist).not.toHaveBeenCalled();
});
