import { useEffect } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { useDebouncedRefetch } from './useDebouncedRefetch.hooks';

/** Render `useDebouncedRefetch` and hand its stable trigger back to the test. */
function Harness({
  refetch,
  delayMs,
  sink,
}: {
  refetch: () => void;
  delayMs?: number;
  sink: (trigger: () => void) => void;
}) {
  const trigger = useDebouncedRefetch(refetch, delayMs);
  useEffect(() => {
    sink(trigger);
  });
  return null;
}

async function mountTrigger(
  refetch: () => void,
  delayMs?: number,
): Promise<{ trigger: () => void; unmount: () => void }> {
  let captured: (() => void) | undefined;
  const view = render(<Harness refetch={refetch} delayMs={delayMs} sink={(t) => (captured = t)} />);
  await vi.waitFor(() => expect(captured).toBeDefined());
  return { trigger: () => captured!(), unmount: view.unmount };
}

test('a burst of rapid calls collapses to a single trailing refetch', async () => {
  const refetch = vi.fn();
  const { trigger } = await mountTrigger(refetch, 250);

  vi.useFakeTimers();
  try {
    // Three calls inside one window — the earlier timers are cleared, so only the
    // last one survives to fire once the burst settles.
    trigger();
    trigger();
    trigger();
    expect(refetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(refetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test('a call after the window settles fires again (trailing edge, not leading)', async () => {
  const refetch = vi.fn();
  const { trigger } = await mountTrigger(refetch, 250);

  vi.useFakeTimers();
  try {
    trigger();
    vi.advanceTimersByTime(250);
    expect(refetch).toHaveBeenCalledTimes(1);

    trigger();
    vi.advanceTimersByTime(250);
    expect(refetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test('a pending timer is cleared on unmount so a late timeout cannot refetch after teardown', async () => {
  const refetch = vi.fn();
  const { trigger, unmount } = await mountTrigger(refetch, 250);

  vi.useFakeTimers();
  try {
    trigger();
    unmount();
    vi.advanceTimersByTime(500);
    expect(refetch).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
