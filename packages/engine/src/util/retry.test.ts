/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_BACKOFF,
  TimeoutError,
  withTimeoutAndRetry,
} from './retry.js';

/** A sleep stub that records requested delays and resolves instantly, so backoff
 *  is exercised without real wall-clock waits. */
function recordingSleep(): {
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

describe('withTimeoutAndRetry', () => {
  test('succeeds on the first try without sleeping', async () => {
    let calls = 0;
    const { sleep, delays } = recordingSleep();

    const result = await withTimeoutAndRetry(
      () => {
        calls += 1;
        return Promise.resolve('ok');
      },
      { retries: 3, backoff: DEFAULT_BACKOFF, sleep },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(1);
    // No failure ⇒ no backoff was ever scheduled.
    expect(delays).toEqual([]);
  });

  test('retries a transient failure and returns the eventual success', async () => {
    let calls = 0;
    const { sleep, delays } = recordingSleep();

    const result = await withTimeoutAndRetry(
      () => {
        calls += 1;
        if (calls < 3) return Promise.reject(new Error(`blip-${calls}`));
        return Promise.resolve(42);
      },
      { retries: 3, backoff: DEFAULT_BACKOFF, sleep },
    );

    expect(result).toBe(42);
    expect(calls).toBe(3);
    // Two failures ⇒ two backoffs before the success.
    expect(delays).toHaveLength(2);
  });

  test('exhausts retries and surfaces the LAST error', async () => {
    let calls = 0;
    const { sleep } = recordingSleep();

    const attempt = withTimeoutAndRetry(
      () => {
        calls += 1;
        return Promise.reject(new Error(`fail-${calls}`));
      },
      { retries: 2, backoff: DEFAULT_BACKOFF, sleep },
    );

    // retries: 2 ⇒ 3 attempts total; the surfaced error is the last attempt's.
    await expect(attempt).rejects.toThrow('fail-3');
    expect(calls).toBe(3);
  });

  test('times out a hung attempt and retries, surfacing a TimeoutError', async () => {
    let calls = 0;
    let lastSignalAborted = false;
    const { sleep } = recordingSleep();

    const attempt = withTimeoutAndRetry<never>(
      (signal) => {
        calls += 1;
        return new Promise<never>(() => {
          // Never settles — only the per-attempt timeout can end it. Record that
          // the timeout aborts the signal handed to a signal-aware callee.
          signal.addEventListener('abort', () => {
            lastSignalAborted = true;
          });
        });
      },
      { retries: 1, timeoutMs: 10, backoff: DEFAULT_BACKOFF, sleep },
    );

    await expect(attempt).rejects.toBeInstanceOf(TimeoutError);
    // retries: 1 ⇒ 2 attempts, each timed out.
    expect(calls).toBe(2);
    expect(lastSignalAborted).toBe(true);
  });

  test('a pre-aborted signal short-circuits before any attempt runs', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));

    const attempt = withTimeoutAndRetry(
      () => {
        calls += 1;
        return Promise.resolve('unreached');
      },
      { retries: 3, signal: controller.signal },
    );

    await expect(attempt).rejects.toThrow('caller cancelled');
    expect(calls).toBe(0);
  });

  test('an abort DURING backoff stops further attempts', async () => {
    let calls = 0;
    const controller = new AbortController();

    const attempt = withTimeoutAndRetry(
      () => {
        calls += 1;
        return Promise.reject(new Error('always fails'));
      },
      {
        retries: 3,
        signal: controller.signal,
        // Simulate the caller cancelling mid-backoff: abort, then let the sleep
        // resolve — the post-backoff abort check must prevent a second attempt.
        sleep: () => {
          controller.abort(new Error('cancelled mid-backoff'));
          return Promise.resolve();
        },
      },
    );

    await expect(attempt).rejects.toThrow('cancelled mid-backoff');
    // Only the first attempt ran; the abort halted the loop before a retry.
    expect(calls).toBe(1);
  });

  test('honors jitter:false for deterministic, capped exponential delays', async () => {
    let calls = 0;
    const { sleep, delays } = recordingSleep();

    await expect(
      withTimeoutAndRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error('nope'));
        },
        {
          retries: 3,
          backoff: { baseMs: 100, factor: 2, maxMs: 250, jitter: false },
          sleep,
        },
      ),
    ).rejects.toThrow('nope');

    expect(calls).toBe(4);
    // 100, 200, then capped at 250 (300 would exceed maxMs).
    expect(delays).toEqual([100, 200, 250]);
  });
});
