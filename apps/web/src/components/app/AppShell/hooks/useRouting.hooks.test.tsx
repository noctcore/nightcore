import { useEffect } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { useRouting } from './useRouting.hooks';

type Router = ReturnType<typeof useRouting>;

/** Render `useRouting` and report its latest controller to the test. */
function Harness({ sink }: { sink: (r: Router) => void }) {
  const router = useRouting();
  useEffect(() => {
    sink(router);
  });
  return null;
}

async function mountRouter(): Promise<() => Router> {
  let latest: Router | undefined;
  render(<Harness sink={(r) => (latest = r)} />);
  await vi.waitFor(() => expect(latest).toBeDefined());
  return () => latest!;
}

test('defaults to the board view with every overlay closed', async () => {
  const router = await mountRouter();
  const r = router();
  expect(r.view).toBe('board');
  expect(r.switcherOpen).toBe(false);
  expect(r.newProjectOpen).toBe(false);
  expect(r.newTaskOpen).toBe(false);
  expect(r.collapsed).toBe(false);
  expect(r.scanTarget).toBeNull();
});

test('goto navigates and closes the switcher', async () => {
  const router = await mountRouter();
  router().toggleSwitcher();
  await vi.waitFor(() => expect(router().switcherOpen).toBe(true));

  router().goto('worktrees');
  await vi.waitFor(() => expect(router().view).toBe('worktrees'));
  expect(router().switcherOpen).toBe(false);
});

test('openNewProject opens the dialog and closes the switcher together', async () => {
  const router = await mountRouter();
  router().toggleSwitcher();
  await vi.waitFor(() => expect(router().switcherOpen).toBe(true));

  router().openNewProject();
  await vi.waitFor(() => expect(router().newProjectOpen).toBe(true));
  expect(router().switcherOpen).toBe(false);

  router().closeNewProject();
  await vi.waitFor(() => expect(router().newProjectOpen).toBe(false));
});

test('gotoSourceRef preselects the scan target and routes to its view', async () => {
  const router = await mountRouter();
  // `insight:<runId>:<itemId>` routes to the insight surface carrying the target.
  router().gotoSourceRef('insight:run-1:item-9');
  await vi.waitFor(() => expect(router().scanTarget).not.toBeNull());
  expect(router().view).toBe(router().scanTarget!.view);

  router().clearScanTarget();
  await vi.waitFor(() => expect(router().scanTarget).toBeNull());
});

test('gotoSourceRef ignores a malformed token (defensive no-op)', async () => {
  const router = await mountRouter();
  router().gotoSourceRef('not-a-valid-ref');
  // Nothing to await on a no-op; flush a tick and assert state is untouched.
  await new Promise((r) => setTimeout(r, 20));
  expect(router().scanTarget).toBeNull();
  expect(router().view).toBe('board');
});
