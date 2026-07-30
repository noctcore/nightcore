/**
 * `SessionManager.handleEvent()`'s body, extracted verbatim for the engine
 * file-size ratchet (#439), alongside the existing `session-query` /
 * `session-models` / `session-start-params` splits. Behavior is unchanged; the
 * collaborators the supervisor already owns are threaded in as
 * {@link SessionEventDeps} instead of `this`.
 *
 * Extracted rather than trimmed on purpose: `session-manager.ts` reached 402 lines
 * against the 400-line cap because two separately-green PRs (#436, #437) each added
 * to it, and a cosmetic collapse back to 399 would re-breach on the next addition.
 * Moving a whole cohesive concern out buys headroom the next change can actually use.
 */
import type { NightcoreEvent } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';
import type { SessionStore } from '@nightcore/storage';

import type { ManagedSession } from './session-manager.js';

/** Exactly the collaborators `handleEvent` touched through `this`. */
export interface SessionEventDeps {
  /** The supervisor's live-session map; a miss means the session already retired. */
  sessions: Map<number, ManagedSession>;
  /** Where a terminal record is persisted on completion/failure. */
  store: SessionStore;
  /** The supervisor's event sink — every path still ends by forwarding the event. */
  emit: (event: NightcoreEvent) => void;
  logger?: Logger;
}

/**
 * Intercept a runner event to update bookkeeping, then forward it. A late event
 * whose session id is no longer live is dropped (monotonic-id guard).
 */
export function applySessionEvent(
  deps: SessionEventDeps,
  id: number,
  event: NightcoreEvent,
): void {
  const session = deps.sessions.get(id);
  if (!session) {
    deps.logger?.debug('dropping event from retired session', { id });
    return;
  }

  switch (event.type) {
    case 'session-ready':
      session.record.sdkSessionId = event.sdkSessionId;
      break;
    case 'permission-required':
      session.record.status = 'awaiting-permission';
      break;
    case 'session-completed':
      session.record.endedAt = Date.now();
      if (event.costUsd !== undefined) {
        session.record.costUsd = event.costUsd;
      }
      session.record.status = 'completed';
      deps.store.save(session.record);
      deps.logger?.info('session completed', {
        id,
        model: session.record.model,
        costUsd: event.costUsd ?? null,
        numTurns: event.numTurns,
      });
      break;
    case 'session-failed':
      session.record.endedAt = Date.now();
      session.record.status = 'failed';
      deps.store.save(session.record);
      deps.logger?.warn('session failed', {
        id,
        model: session.record.model,
        reason: event.reason,
      });
      break;
  }

  deps.emit(event);
}
