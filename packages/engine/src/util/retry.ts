/**
 * `withTimeoutAndRetry` — bound + recover an EXTERNAL, read-only, IDEMPOTENT call
 * (issue #252).
 *
 * The engine's provider PROBE / CATALOG reads (model listing, provider-config
 * inspection) currently let a single transient failure mask as an empty list or an
 * `unavailable` section. This wraps such a call so a transient blip RECOVERS the
 * real result, and only degrades after genuine, repeated failure.
 *
 * IN SCOPE: read-only probe/catalog reads that are safe to run more than once.
 * OUT OF SCOPE — deliberately: the turn-driving session loop (`SessionRunner.run`
 * / the Codex `runStreamed` loop). Those are stateful and already have idle
 * watchdogs + cancellation + a single corrective retry; blanket-retrying them would
 * risk double-execution, cost blow-ups, and lifecycle races. Only wrap a call whose
 * repetition is a no-op.
 *
 * Guarantees:
 *  - Each attempt is optionally raced against `timeoutMs` — both by aborting the
 *    per-attempt `AbortController` (for callees that accept the signal, e.g. a
 *    child process that can be killed) AND by `Promise.race` (so a callee that
 *    ignores the signal still stops being awaited). Omit `timeoutMs` to rely on the
 *    callee's own per-call bound.
 *  - On failure/timeout it retries up to `retries` times with capped exponential
 *    backoff + jitter.
 *  - A caller-provided `signal` short-circuits: an abort before, between, or during
 *    the backoff of attempts stops all further work — no attempt starts after abort.
 *  - After the last attempt it re-throws the LAST error, so the caller's existing
 *    degrade-to-empty `catch` still applies. This only IMPROVES recovery; it never
 *    converts a previously-degrading call into a throw that reaches the UI.
 */

/** Thrown when a single attempt exceeds `timeoutMs`. Retryable like any failure. */
export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`operation timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/** Capped exponential-backoff shape for the delay BETWEEN attempts. */
export interface BackoffOptions {
  /** Delay before the FIRST retry (ms). */
  readonly baseMs: number;
  /** Exponential multiplier applied per prior retry (`baseMs * factor ** n`). */
  readonly factor: number;
  /** Upper bound on any single backoff delay (ms). */
  readonly maxMs: number;
  /** Equal-jitter (delay ∈ [d/2, d]) to decorrelate aligned failures. Default `true`. */
  readonly jitter?: boolean;
}

/** Diagnostics for a failed attempt, surfaced just before the next one is scheduled. */
export interface RetryAttemptInfo {
  /** 1-based index of the attempt that just failed. */
  readonly attempt: number;
  /** The error (or {@link TimeoutError}) that failed the attempt. */
  readonly error: unknown;
  /** Backoff delay before the next attempt (ms). */
  readonly delayMs: number;
}

export interface TimeoutAndRetryOptions {
  /** Number of RETRIES after the first attempt (total attempts = `retries + 1`). */
  readonly retries: number;
  /** Per-attempt timeout in ms. Omit to rely on the callee's own bound. */
  readonly timeoutMs?: number;
  /** Backoff config. Defaults to {@link DEFAULT_BACKOFF}. */
  readonly backoff?: BackoffOptions;
  /** Caller cancellation — an aborted signal short-circuits the whole operation. */
  readonly signal?: AbortSignal;
  /** Injectable sleep (tests). Defaults to a real timer that honors `signal`. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called once per failed attempt that will be retried (for logging). */
  readonly onRetry?: (info: RetryAttemptInfo) => void;
}

/** Sensible interactive-probe default: three attempts within ~1s of added latency. */
export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 200,
  factor: 2,
  maxMs: 2_000,
  jitter: true,
};

export async function withTimeoutAndRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: TimeoutAndRetryOptions,
): Promise<T> {
  const {
    retries,
    timeoutMs,
    backoff = DEFAULT_BACKOFF,
    signal,
    sleep = defaultSleep,
    onRetry,
  } = options;

  throwIfAborted(signal);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await runAttempt(fn, timeoutMs, signal);
    } catch (error) {
      lastError = error;
      // A caller abort is terminal — never retry past it.
      throwIfAborted(signal);
      if (attempt === retries) break;
      const delayMs = backoffDelay(attempt, backoff);
      onRetry?.({ attempt: attempt + 1, error, delayMs });
      await sleep(delayMs, signal);
      // The caller may have aborted DURING the backoff.
      throwIfAborted(signal);
    }
  }
  throw lastError;
}

/**
 * Run one attempt: pass it a fresh {@link AbortSignal} (aborted on the caller's
 * signal or on timeout), race it against `timeoutMs`, and clean up the timer /
 * listener afterwards. Rejects on failure OR timeout so the retry loop can react.
 */
async function runAttempt<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  callerSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort(abortReason(callerSignal));
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) controller.abort(abortReason(callerSignal));
    else callerSignal.addEventListener('abort', relayAbort, { once: true });
  }

  try {
    const work = fn(controller.signal);
    if (timeoutMs === undefined) return await work;

    // A callee that ignores the signal keeps running after the race is lost;
    // swallow its late settlement so the abandoned attempt can't surface as an
    // unhandled rejection.
    void work.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new TimeoutError(timeoutMs);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } finally {
    if (callerSignal !== undefined) {
      callerSignal.removeEventListener('abort', relayAbort);
    }
  }
}

/** The delay before retry `priorRetries + 1`, capped then (optionally) jittered. */
function backoffDelay(priorRetries: number, backoff: BackoffOptions): number {
  const capped = Math.min(backoff.baseMs * backoff.factor ** priorRetries, backoff.maxMs);
  if (backoff.jitter === false) return Math.round(capped);
  // Equal jitter keeps at least half the delay (so retries still space out) while
  // decorrelating failures that would otherwise align across concurrent probes.
  return Math.round(capped / 2 + Math.random() * (capped / 2));
}

/** A real timer that resolves after `ms`, or rejects early if `signal` aborts. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Throw the abort reason if `signal` is already aborted; otherwise a no-op. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}

/** The reason to abort a downstream controller with when the caller aborts. */
function abortReason(signal: AbortSignal | undefined): Error {
  return abortError(signal);
}

/** Normalize a signal's `reason` (typed `any`) into an `Error`. */
function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error('operation aborted');
}
