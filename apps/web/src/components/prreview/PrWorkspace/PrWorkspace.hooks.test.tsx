import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the Tauri command surface underneath the bridge (the PrStatusCard.test
// seam) so `pr_changed_files` is observable and controllable per call. The
// bridge gates the real invoke on `isTauri()`, satisfied by stubbing
// `window.__TAURI_INTERNALS__` in `beforeEach`.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

import { useChangedFiles } from './PrWorkspace.hooks';

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

/** A minimal probe over the hook: expand toggles the fetch, and the error branch
 *  exposes the Retry affordance the fix adds. */
function Probe() {
  const changed = useChangedFiles(40);
  return (
    <div>
      <button onClick={changed.toggle}>toggle</button>
      {changed.loading && <span>loading</span>}
      {changed.error !== null && (
        <>
          <span>err:{changed.error}</span>
          <button onClick={changed.retry}>retry</button>
        </>
      )}
      <span>files:{changed.files.length}</span>
    </div>
  );
}

test('useChangedFiles: Retry re-runs the on-expand fetch after a failure', async () => {
  let call = 0;
  invoke.mockImplementation((cmd: unknown) => {
    if (cmd === 'pr_changed_files') {
      call += 1;
      if (call === 1) return Promise.reject(new Error('gh: rate limited'));
      return Promise.resolve([{ path: 'src/a.ts', additions: 3, deletions: 1 }]);
    }
    return Promise.resolve(undefined);
  });

  const screen = render(<Probe />);
  // Expand → the first fetch fails, so no files land and the error surfaces.
  await screen.getByRole('button', { name: 'toggle' }).click();
  await expect.element(screen.getByText('err:gh: rate limited')).toBeInTheDocument();
  expect(screen.container.textContent).toContain('files:0');

  // Retry re-runs the fetch without a collapse round trip (loadedForRef stays
  // null on error), and the second attempt succeeds → the files land.
  await screen.getByRole('button', { name: 'retry' }).click();
  await expect.element(screen.getByText('files:1')).toBeInTheDocument();
  expect(call).toBe(2);
});
