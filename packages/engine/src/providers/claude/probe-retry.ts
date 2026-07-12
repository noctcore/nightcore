/**
 * Bounded retry + teardown for the Claude read-only TRANSIENT probe (issue #252).
 *
 * The provider-config inspector and the model picker read the SDK's control
 * surface (model list / MCP status / skills / subagents / init) off a transient,
 * input-less subprocess that runs NO model turn. A transient spawn/read blip
 * currently masks as an empty list / an `unavailable` section; this wraps each
 * probe in a small, bounded retry so a blip RECOVERS the real result, then still
 * degrades to the caller's `fallback` if every attempt genuinely fails
 * (degrade-not-throw preserved).
 *
 * OUT OF SCOPE — deliberately: the turn-driving run loop (`SessionRunner.run`) and
 * the live-query reuse path. Those are stateful and must NOT be retried (a re-run
 * risks a double turn, cost blow-ups, and lifecycle races). This wrapper only ever
 * opens a FRESH, isolated, read-only subprocess, so repetition is a safe no-op.
 *
 * SDK-free by design (generic over a `ProbeHandle`), so the Claude Agent SDK stays
 * confined to its callers under `providers/claude/**` — this module composes the
 * neutral `util/retry` helper with a caller-supplied probe lifecycle.
 */
import type { Logger } from '@nightcore/shared';

import { type BackoffOptions, withTimeoutAndRetry } from '../../util/retry.js';

/**
 * Small and bounded: each attempt is ALREADY deadline-capped by the caller's
 * `race`, and only a FAST transient failure (spawn error / read rejection)
 * triggers a retry — a wedged probe resolves to the fallback via that deadline and
 * is NOT re-waited, so worst-case latency stays ~one deadline, not N of them. A
 * persistently-failing probe therefore degrades ~one backoff window later than
 * before (sub-second), while a transient blip now recovers.
 */
const PROBE_RETRIES = 2;
const PROBE_BACKOFF: BackoffOptions = {
  baseMs: 150,
  factor: 2,
  maxMs: 1_000,
  jitter: true,
};

/** The minimum a transient probe handle must expose for teardown. */
export interface ProbeHandle {
  interrupt(): Promise<void>;
}

export interface TransientProbeContext<T, Q extends ProbeHandle> {
  /** Open a fresh transient probe subprocess bound to `abort`, rooted at
   *  `cwdOverride` when given. Throwing here is a retryable spawn failure. */
  readonly openProbe: (abort: AbortController, cwdOverride?: string) => Q;
  /** Race a probe read against the caller's deadline, resolving to `fallback` on a
   *  wedge — so a wedge is NOT treated as a retryable blip. A rejection propagates
   *  (a genuine transient read failure) and IS retried. */
  readonly race: (work: Promise<T>, fallback: T) => Promise<T>;
  readonly logger?: Logger;
}

/**
 * Run `body` against a transient probe, retrying a transient blip up to
 * {@link PROBE_RETRIES} times before degrading to `fallback`. Never throws past
 * this boundary — the caller keeps its existing degrade-to-fallback contract.
 */
export async function withTransientProbeRetry<T, Q extends ProbeHandle>(
  body: (probe: Q) => Promise<T>,
  fallback: T,
  cwdOverride: string | undefined,
  ctx: TransientProbeContext<T, Q>,
): Promise<T> {
  try {
    return await withTimeoutAndRetry(
      () => attemptProbe(body, fallback, cwdOverride, ctx),
      {
        retries: PROBE_RETRIES,
        backoff: PROBE_BACKOFF,
        onRetry: ({ attempt, error }) =>
          ctx.logger?.debug('control probe retrying transient blip', {
            attempt,
            error,
          }),
      },
    );
  } catch (error) {
    ctx.logger?.debug('control probe exhausted retries — degrading to fallback', error);
    return fallback;
  }
}

/**
 * One transient-probe attempt: open a fresh subprocess, run `body` bounded by the
 * caller's `race`, and tear it down in `finally`. THROWS on a spawn failure or a
 * `body` rejection so {@link withTransientProbeRetry} can retry the blip; a
 * deadline hit resolves to `fallback` (a wedge is not a retryable blip).
 */
async function attemptProbe<T, Q extends ProbeHandle>(
  body: (probe: Q) => Promise<T>,
  fallback: T,
  cwdOverride: string | undefined,
  ctx: TransientProbeContext<T, Q>,
): Promise<T> {
  const abort = new AbortController();
  let probe: Q | undefined;
  try {
    probe = ctx.openProbe(abort, cwdOverride);
    return await ctx.race(body(probe), fallback);
  } finally {
    abort.abort();
    await probe?.interrupt().catch((error: unknown) => {
      // Teardown is best-effort: the abort above already tore the query down, so an
      // interrupt rejection here is expected and harmless — record it at debug.
      ctx.logger?.debug('probe teardown interrupt failed', error);
    });
  }
}
