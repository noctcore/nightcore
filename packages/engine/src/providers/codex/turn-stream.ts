import type { NightcoreEvent } from '@nightcore/contracts';

import type { SessionEventSink } from '../agent-provider.js';
import {
  type CodexTranslationState,
  type ThreadEvent,
  translateCodexEvent,
} from './sdk-adapter.js';

/**
 * Default idle watchdog deadline for a Codex turn: 30 minutes with NO stream event
 * resets the timer on every yield. Mirrors the Claude runner's
 * `DEFAULT_IDLE_TIMEOUT_MS` — deliberately generous so one long tool call (a
 * multi-minute build) that emits no `ThreadEvent`s isn't killed, while a genuinely
 * wedged `codex exec` (stopped yielding, no terminal `turn.completed`/`turn.failed`)
 * is reaped instead of hanging the run and leaking its concurrency slot forever.
 * Injectable via the provider/session constructor for tests only.
 */
export const CODEX_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Sentinel returned by {@link nextWithIdleDeadline} when the idle watchdog fires
 *  before the turn's event stream yields its next event. */
export const CODEX_IDLE_STALLED = Symbol('codex-idle-stalled');

/**
 * Drive one turn's event stream to its terminal event under an idle deadline.
 * Returns the held terminal events when the turn completes/fails in time,
 * `undefined` when the stream ends with no terminal event, or
 * {@link CODEX_IDLE_STALLED} when the watchdog fires first (a wedged subprocess).
 * Non-terminal events are emitted as they arrive, exactly like the prior
 * `for await` loop — the only change is the per-`next()` idle race.
 */
export async function drainTurnEvents(
  events: AsyncIterable<ThreadEvent>,
  state: CodexTranslationState,
  emit: SessionEventSink,
  idleTimeoutMs: number,
): Promise<NightcoreEvent[] | undefined | typeof CODEX_IDLE_STALLED> {
  const iterator = events[Symbol.asyncIterator]();
  for (;;) {
    const next = await nextWithIdleDeadline(iterator, idleTimeoutMs);
    if (next === CODEX_IDLE_STALLED) return CODEX_IDLE_STALLED;
    if (next.done === true) return undefined;
    const translated = translateCodexEvent(next.value, state);
    if (translated.terminal) return translated.events;
    for (const event of translated.events) emit(event);
  }
}

/**
 * Await the stream's next event under an idle deadline. Returns the
 * `IteratorResult` when the turn yields (or ends) in time, or
 * {@link CODEX_IDLE_STALLED} when the given `idleTimeoutMs` elapses first. A
 * fresh timer per call, so every yielded event resets it — only a genuinely
 * quiet (wedged) stream trips it. When the timer wins, the dangling `next()`
 * promise's eventual rejection (from the turn abort) is swallowed so it never
 * surfaces as an unhandled rejection. Mirrors the Claude runner's
 * `nextWithIdleDeadline`.
 */
async function nextWithIdleDeadline(
  iterator: AsyncIterator<ThreadEvent>,
  idleTimeoutMs: number,
): Promise<IteratorResult<ThreadEvent> | typeof CODEX_IDLE_STALLED> {
  const nextPromise = iterator.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<typeof CODEX_IDLE_STALLED>((resolve) => {
    timer = setTimeout(() => resolve(CODEX_IDLE_STALLED), idleTimeoutMs);
  });
  try {
    const result = await Promise.race([nextPromise, idle]);
    if (result === CODEX_IDLE_STALLED) {
      void Promise.resolve(nextPromise).catch(() => {});
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
