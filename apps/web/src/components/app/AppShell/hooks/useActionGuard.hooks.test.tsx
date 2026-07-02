import { useEffect, useState } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import { type ActionGuard,useActionGuard } from './useActionGuard.hooks';

/** Renders `useActionGuard`, reports the returned `action` after every commit, and
 *  exposes two triggers: an unrelated re-render (the per-frame stream-flush case)
 *  and starting a guarded action (which flips the pending set). */
function Harness({ sink }: { sink: (action: ActionGuard) => void }) {
  const action = useActionGuard();
  const [, setTick] = useState(0);
  useEffect(() => {
    sink(action);
  });
  return (
    <div>
      <button type="button" onClick={() => setTick((n) => n + 1)}>
        rerender
      </button>
      <button
        type="button"
        onClick={() =>
          action.guard('run', 'x', () => new Promise<void>(() => {
            /* never settles — keep `run:x` pending for the assertion */
          }))
        }
      >
        guard
      </button>
    </div>
  );
}

test('useActionGuard keeps `action` stable across renders that do not touch the pending set', async () => {
  const seen: ActionGuard[] = [];
  const screen = render(<Harness sink={(action) => seen.push(action)} />);
  const first = seen.at(-1)!;
  // A parent-driven re-render with no guard-state change — the per-frame stream
  // flush — must hand back the SAME `action`. An unmemoized literal here would
  // re-identify every guarded handler in AppShell (and thus `detailActions`), so
  // the memoized TaskDetailChrome and the Board's memoized cards could never bail
  // on a flush. This is the invariant the drawer's render insulation rests on.
  await screen.getByRole('button', { name: 'rerender' }).click();
  expect(seen.at(-1)).toBe(first);
});

test('useActionGuard turns `action` over when the pending set transitions', async () => {
  const seen: ActionGuard[] = [];
  const screen = render(<Harness sink={(action) => seen.push(action)} />);
  const before = seen.at(-1)!;
  // Starting a guarded action flips `isPending`, so `action` MUST re-identify —
  // that propagation is exactly what disables the in-flight footer button. The
  // memoization stabilizes identity WITHOUT freezing real guard-state changes.
  await screen.getByRole('button', { name: 'guard' }).click();
  const after = seen.at(-1)!;
  expect(after).not.toBe(before);
  expect(after.isPending('run', 'x')).toBe(true);
  expect(before.isPending('run', 'x')).toBe(false);
});
