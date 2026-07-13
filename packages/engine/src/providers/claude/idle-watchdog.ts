/**
 * The idle watchdog for a `SessionRunner`'s main run loop: awaits the SDK
 * iterator's next message under a deadline so a wedged subprocess (stopped
 * yielding without a terminal `result`) can't hang the loop forever and leak its
 * concurrency slot.
 */
import type { SDKMessage } from './sdk-adapter.js';

/**
 * Default idle deadline for the main run loop: 30 minutes with NO SDK message
 * resets the timer on every yield. Deliberately generous — one long tool call (a
 * multi-minute build, a full test suite, a large download) produces no
 * intermediate SDK messages, so a tight deadline would kill healthy work. Only a
 * genuinely wedged subprocess should trip it, freeing the slot it would otherwise
 * leak forever. Overridable per-session via `SessionRunnerConfig.idleTimeoutMs`.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Sentinel returned by {@link nextWithIdleDeadline} when the idle watchdog fires
 *  before the SDK yields the next message. */
export const IDLE_STALLED = Symbol('idle-stalled');

/** Internal sentinel for one elapsed idle window. Distinct from {@link
 *  IDLE_STALLED}: an elapsed window only STALLS when no human decision is pending;
 *  otherwise the deadline re-arms (a parked plan/question may wait indefinitely —
 *  T6 #147). */
const IDLE_TICK = Symbol('idle-tick');

export interface IdleDeadlineOptions {
  /** Idle deadline (ms). A fresh timer per elapsed window, so it resets on every
   *  yielded message — only a genuinely quiet (wedged) stream trips it. */
  readonly idleTimeoutMs: number;
  /** True while the run is legitimately parked awaiting a HUMAN decision (a pending
   *  interactive permission — including a plan-mode `ExitPlanMode` — or a pending
   *  `AskUserQuestion`). The watchdog NEVER trips while this holds. */
  readonly awaitingHumanDecision: () => boolean;
}

/**
 * Await the iterator's next message under an idle deadline. Returns the
 * `IteratorResult` when the SDK yields (or completes) in time, or {@link
 * IDLE_STALLED} when `idleTimeoutMs` elapses with the stream genuinely wedged.
 *
 * CRITICAL (T6 #147): an elapsed window while a human decision is pending (a parked
 * plan, permission, or question — {@link IdleDeadlineOptions.awaitingHumanDecision})
 * is NOT a stall. A run may wait indefinitely for the user, so the deadline re-arms
 * and keeps awaiting the SAME `next()` instead of failing the run. The exclusion
 * covers a decision that becomes pending mid-window too: the check runs when the
 * timer fires, not just at entry. When the SDK finally yields (or the timer wins
 * with no pending decision) the dangling `next()` rejection from teardown is
 * swallowed so it never surfaces as an unhandled rejection.
 */
export async function nextWithIdleDeadline(
  iterator: AsyncIterator<SDKMessage>,
  opts: IdleDeadlineOptions,
): Promise<IteratorResult<SDKMessage> | typeof IDLE_STALLED> {
  const nextPromise = iterator.next();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<typeof IDLE_TICK>((resolve) => {
      timer = setTimeout(() => resolve(IDLE_TICK), opts.idleTimeoutMs);
    });
    try {
      const result = await Promise.race([nextPromise, idle]);
      // The SDK yielded or completed in time — hand it straight back.
      if (result !== IDLE_TICK) return result;
      // A full idle window elapsed. If a human decision is pending, this is BY
      // DESIGN — re-arm the deadline and keep awaiting the same next() (never
      // stall a parked plan). Otherwise the stream is genuinely wedged.
      if (opts.awaitingHumanDecision()) continue;
      // The next() promise may reject later when teardown aborts the query —
      // attach a no-op catch now so it never bubbles as unhandled.
      void Promise.resolve(nextPromise).catch(() => {});
      return IDLE_STALLED;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
