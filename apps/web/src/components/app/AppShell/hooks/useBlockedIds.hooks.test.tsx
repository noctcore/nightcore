import { useEffect } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Mock the bridge seam so the `blocked_task_ids` fetch and the `nc:task`
// subscription are fully controllable — the real relative `useDebouncedRefetch`
// still runs, so the immediate-first-load → debounced-refresh path is exercised.
const blockedTaskIds = vi.fn<() => Promise<string[]>>();
let taskHandler: (() => void) | undefined;
const onTaskEvent = vi.fn((h: () => void) => {
  taskHandler = h;
  return Promise.resolve(() => {});
});
vi.mock('@/lib/bridge', () => ({
  blockedTaskIds: () => blockedTaskIds(),
  onTaskEvent: (h: () => void) => onTaskEvent(h),
}));

import { useBlockedIds } from './useBlockedIds.hooks';

afterEach(() => {
  blockedTaskIds.mockReset();
  onTaskEvent.mockClear();
  taskHandler = undefined;
});

/** A promise plus its external resolver, for driving out-of-order responses. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Render `useBlockedIds` and push each returned Set to the test for inspection. */
function Harness({ sink }: { sink: (ids: Set<string>) => void }) {
  const ids = useBlockedIds();
  useEffect(() => {
    sink(ids);
  });
  return null;
}

function renderBlocked(): Set<string>[] {
  const seen: Set<string>[] = [];
  render(<Harness sink={(ids) => seen.push(ids)} />);
  return seen;
}

test('fetches the blocked set immediately on mount (first load is not debounced)', async () => {
  blockedTaskIds.mockResolvedValue(['a', 'b']);
  const seen = renderBlocked();

  // The mount effect fetches straight away — no timer advance needed.
  await vi.waitFor(() => expect(blockedTaskIds).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect([...seen[seen.length - 1]!].sort()).toEqual(['a', 'b']));
});

test('an out-of-order (older, slower) response is dropped and cannot clobber a newer one', async () => {
  const first = deferred<string[]>();
  const second = deferred<string[]>();
  // First call = the mount fetch (seq 1); second = the event-driven refresh (seq 2).
  blockedTaskIds.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const seen = renderBlocked();

  await vi.waitFor(() => expect(blockedTaskIds).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(taskHandler).toBeDefined());

  // A `nc:task` burst schedules the debounced refresh; wait for the second fetch.
  taskHandler!();
  await vi.waitFor(() => expect(blockedTaskIds).toHaveBeenCalledTimes(2));

  // The NEWER request (seq 2) resolves first and is applied.
  second.resolve(['new']);
  await vi.waitFor(() => expect([...seen[seen.length - 1]!]).toEqual(['new']));

  // The OLDER request (seq 1) resolves late — its id is below `applied`, so it is
  // dropped rather than reverting the board to the stale set.
  first.resolve(['stale']);
  await new Promise((r) => setTimeout(r, 50));
  expect([...seen[seen.length - 1]!]).toEqual(['new']);
});

test('a burst of task events collapses to a single debounced refetch', async () => {
  blockedTaskIds.mockResolvedValue([]);
  renderBlocked();

  await vi.waitFor(() => expect(blockedTaskIds).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(taskHandler).toBeDefined());

  // Three events inside the debounce window coalesce into one trailing refetch.
  taskHandler!();
  taskHandler!();
  taskHandler!();
  await vi.waitFor(() => expect(blockedTaskIds).toHaveBeenCalledTimes(2));
  // Give the window well past its trailing edge; no further fetch is dispatched.
  await new Promise((r) => setTimeout(r, 400));
  expect(blockedTaskIds).toHaveBeenCalledTimes(2);
});
