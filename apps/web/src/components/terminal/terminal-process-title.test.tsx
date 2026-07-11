import { afterEach, expect, test, vi } from 'vitest';

import {
  forgetProcessTitle,
  recordProcessTitle,
  setProcessTitleApplier,
  subscribeProcessTitle,
} from './terminal-process-title';

afterEach(() => {
  setProcessTitleApplier(null);
  for (const id of ['s1', 's2']) forgetProcessTitle(id);
});

test('debounces the title stream, applies once, and notifies only names that stuck', async () => {
  const applied: Array<[string, string]> = [];
  const applier = vi.fn((id: string, title: string): Promise<string | null> => {
    applied.push([id, title]);
    return Promise.resolve(title); // the server accepts it (returns the applied title)
  });
  setProcessTitleApplier(applier);
  const notified: Array<[string, string]> = [];
  const unsub = subscribeProcessTitle((id, title) => notified.push([id, title]));

  // A burst of retitles (a chatty shell) collapses to ONE apply of the latest value.
  recordProcessTitle('s1', 'cd app');
  recordProcessTitle('s1', 'npm install');
  recordProcessTitle('s1', 'npm run dev');

  await vi.waitFor(() => expect(applier).toHaveBeenCalledTimes(1));
  expect(applied).toEqual([['s1', 'npm run dev']]);
  await vi.waitFor(() => expect(notified).toEqual([['s1', 'npm run dev']]));

  unsub();
});

test('a refused apply (server returns null) does not update the tab', async () => {
  // A Manual/Task/AI-named tab: the server refuses the process-title (returns null).
  setProcessTitleApplier(() => Promise.resolve(null));
  const notified: string[] = [];
  const unsub = subscribeProcessTitle((_id, title) => notified.push(title));

  recordProcessTitle('s2', 'vim');
  // Give the debounce + the (resolved-null) apply a chance to run.
  await new Promise((r) => setTimeout(r, 550));
  expect(notified).toEqual([]);

  unsub();
});

test('blank titles are ignored', async () => {
  const applier = vi.fn(() => Promise.resolve<string | null>('x'));
  setProcessTitleApplier(applier);
  recordProcessTitle('s1', '   ');
  await new Promise((r) => setTimeout(r, 550));
  expect(applier).not.toHaveBeenCalled();
});
