/**
 * Preflight-refusal mapping — extracted from {@link
 * import('./session-manager.js').SessionManager} for the engine file-size ratchet, mirroring
 * `session-start-params.ts`. Behavior verbatim.
 *
 * A provider REFUSES a start at the seam (issue #296) rather than silently dropping it: an
 * autonomy it can't confine (`AutonomyNotPermittedError`) or an ARMED Harness policy it can't
 * govern (`GovernanceNotSupportedError`). This maps that refusal to the terminal
 * `session-failed` the board renders like any other failure. No runner started, so — unlike a
 * crash — no concurrency slot was taken.
 */
import type { NightcoreEvent } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import {
  AutonomyNotPermittedError,
  GovernanceNotSupportedError,
} from '../providers/agent-provider.js';

/**
 * Build the terminal `session-failed` event for a preflight refusal, or return `null` when
 * `error` is NOT a preflight refusal (the caller rethrows). Logs the refusal.
 */
export function refusalEvent(
  id: number,
  error: unknown,
  logger: Logger | undefined,
): Extract<NightcoreEvent, { type: 'session-failed' }> | null {
  if (error instanceof AutonomyNotPermittedError) {
    logger?.warn('session refused: autonomy not permitted', {
      id,
      providerId: error.providerId,
      autonomy: error.autonomy,
    });
    return {
      type: 'session-failed',
      sessionId: id,
      reason: 'runner-crash',
      message: error.message,
    };
  }
  if (error instanceof GovernanceNotSupportedError) {
    logger?.warn('session refused: governance not supported', {
      id,
      providerId: error.providerId,
    });
    return {
      type: 'session-failed',
      sessionId: id,
      reason: 'runner-crash',
      message: error.message,
    };
  }
  return null;
}
