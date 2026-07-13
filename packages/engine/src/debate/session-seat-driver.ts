/**
 * The production {@link SeatDriver} (issue #350): maps one seat turn onto a one-shot
 * provider session and collects its output.
 *
 * P1 deliberately keeps this SIMPLE (the design's "for now, dispatch to seats directly
 * via the existing session path"). A seat turn = one session started with the
 * Conductor-assembled prompt; the seat's answer is the session's terminal `result`
 * text. The robust broadcast collector — bounded concurrency, quorum, and per-seat
 * timeouts so a hung seat can't stall the board — is issue #351; this driver is its
 * simplest correct predecessor.
 *
 * Correlation is race-free WITHOUT the #351 collector because the backend's
 * {@link SeatSessionBackend.spawn} returns the session's monotonic id SYNCHRONOUSLY
 * (the engine assigns it before any await). The driver subscribes first, spawns to
 * learn the exact id, then folds only that id's events — so concurrent blind-Propose
 * turns never cross wires.
 *
 * Sandbox posture is out of scope here: per-seat OS sandbox + governance tier is
 * issue #354. A seat runs as an ordinary read-mostly session; the injection firewall
 * (mediated, quoted, scanned peer delivery) is enforced by the Conductor, not here.
 */
import type { NightcoreEvent, TokenUsage } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type {
  SeatDriver,
  SeatTurnRequest,
  SeatTurnResult,
} from './conductor-types.js';

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningOutputTokens: 0,
};

/** The parameters a seat turn starts its one-shot session with. */
export interface SeatSessionParams {
  readonly prompt: string;
  readonly model: string;
  readonly cwd?: string;
}

/**
 * The narrow engine seam this driver needs — a subset of the {@link
 * import('../session/session-manager.js').SessionManager} surface. Injecting it (not
 * the whole supervisor) keeps the driver unit-testable with a fake backend.
 */
export interface SeatSessionBackend {
  /** Start a one-shot session for a seat turn and return its monotonic session id
   *  SYNCHRONOUSLY (assigned before any await), so events can be correlated race-free. */
  spawn(params: SeatSessionParams): number;
  /** Subscribe to the engine event stream; returns an unsubscribe fn. */
  on(listener: (event: NightcoreEvent) => void): () => void;
}

export interface SessionSeatDriverDeps {
  readonly backend: SeatSessionBackend;
  readonly logger?: Logger;
}

export class SessionSeatDriver implements SeatDriver {
  constructor(private readonly deps: SessionSeatDriverDeps) {}

  /**
   * Run one seat turn: spawn a session for `prompt`, then resolve on that session's
   * terminal event. A `session-completed` yields the seat's `result` + spend; a
   * `session-failed` (or an abort) degrades to an EMPTY turn (zero content + zero
   * spend) so one broken seat never rejects the whole council — the debate proceeds
   * with the remaining positions.
   */
  runTurn(request: SeatTurnRequest): Promise<SeatTurnResult> {
    if (request.signal.aborted) return Promise.resolve(this.empty());

    return new Promise<SeatTurnResult>((resolve) => {
      // Filled by `spawn` below (synchronously, before any async event), so the
      // listener — which only fires later — always sees the correlated id. A holder
      // (not a bare `let`) keeps it a const the closure closes over.
      const correlation: { sessionId?: number } = {};
      let settled = false;
      let unsubscribe = (): void => {};

      const finish = (result: SeatTurnResult): void => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener('abort', onAbort);
        unsubscribe();
        resolve(result);
      };

      const onAbort = (): void => {
        this.deps.logger?.debug('seat turn aborted before completion', {
          seatId: request.seat.seatId,
        });
        finish(this.empty());
      };
      request.signal.addEventListener('abort', onAbort, { once: true });

      // Subscribe BEFORE spawning so a fast terminal event is never missed. Only the
      // two terminal, session-scoped events matter — narrow first so `sessionId` is
      // known to exist (query-result events carry no session id).
      unsubscribe = this.deps.backend.on((event) => {
        if (event.type !== 'session-completed' && event.type !== 'session-failed') {
          return;
        }
        if (
          correlation.sessionId === undefined ||
          event.sessionId !== correlation.sessionId
        ) {
          return;
        }
        if (event.type === 'session-completed') {
          finish({
            content: event.result,
            usage: event.usage ?? ZERO_USAGE,
            costUsd: event.costUsd ?? 0,
          });
        } else {
          this.deps.logger?.warn('seat session failed; contributing an empty turn', {
            seatId: request.seat.seatId,
            reason: event.reason,
          });
          finish(this.empty());
        }
      });

      correlation.sessionId = this.deps.backend.spawn({
        prompt: request.prompt,
        model: request.seat.model,
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      });
    });
  }

  private empty(): SeatTurnResult {
    return { content: '', usage: ZERO_USAGE, costUsd: 0 };
  }
}
