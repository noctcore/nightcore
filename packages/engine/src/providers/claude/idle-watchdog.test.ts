/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import { IDLE_STALLED, nextWithIdleDeadline } from './idle-watchdog.js';
import type { SDKMessage } from './sdk-adapter.js';

/** A fake SDK message iterator whose `next()` resolves with `value` after `delayMs`
 *  (or never, when `delayMs` is `Infinity`), so a test can model a wedged stream. */
function iteratorYielding(
  value: IteratorResult<SDKMessage>,
  delayMs: number,
): AsyncIterator<SDKMessage> {
  return {
    next: () =>
      delayMs === Infinity
        ? new Promise<IteratorResult<SDKMessage>>(() => {})
        : new Promise<IteratorResult<SDKMessage>>((resolve) =>
            setTimeout(() => resolve(value), delayMs),
          ),
  };
}

const message = { value: { type: 'assistant' } as SDKMessage, done: false };

describe('nextWithIdleDeadline', () => {
  test('returns the iterator result when the SDK yields within the deadline', async () => {
    const result = await nextWithIdleDeadline(iteratorYielding(message, 1), {
      idleTimeoutMs: 1000,
      awaitingHumanDecision: () => false,
    });
    expect(result).toEqual(message);
  });

  test('returns IDLE_STALLED when the deadline elapses with no human decision pending', async () => {
    const result = await nextWithIdleDeadline(iteratorYielding(message, Infinity), {
      idleTimeoutMs: 10,
      awaitingHumanDecision: () => false,
    });
    expect(result).toBe(IDLE_STALLED);
  });

  test('re-arms indefinitely while a human decision is pending (T6 #147)', async () => {
    // Many deadline windows elapse before the iterator yields; with a pending human
    // decision throughout, the watchdog must NEVER stall — it re-arms and returns
    // the real value once it finally arrives.
    const result = await nextWithIdleDeadline(iteratorYielding(message, 60), {
      idleTimeoutMs: 5,
      awaitingHumanDecision: () => true,
    });
    expect(result).toEqual(message);
  });

  test('stalls once the human wait clears and a window elapses with nothing pending', async () => {
    let pending = true;
    // Pending for the first elapsed window (re-arm), then clears — the next elapsed
    // window with nothing pending is a genuine stall.
    setTimeout(() => {
      pending = false;
    }, 12);
    const result = await nextWithIdleDeadline(iteratorYielding(message, Infinity), {
      idleTimeoutMs: 8,
      awaitingHumanDecision: () => pending,
    });
    expect(result).toBe(IDLE_STALLED);
  });
});
