/**
 * The Council BROADCAST COLLECTOR (issue #351) — the primitive that dispatches ONE
 * prompt to N seats and resolves on **quorum OR timeout**, so a hung or slow seat can
 * never stall the board. It hardens the Conductor's P1 dispatch (which #350 kept
 * deliberately simple) with three guarantees:
 *
 *  - **Bounded concurrency.** At most `maxConcurrency` seats are dispatched at once,
 *    reusing the scan pool ({@link import('../scans/shared/pool.js').runPool}) rather
 *    than reinventing a limiter — one concurrency fix, one place.
 *  - **Quorum OR timeout resolution.** Each seat has a per-seat timeout; a seat that
 *    doesn't answer in time is recorded `timed-out` and the collector moves on — even
 *    if the seat's driver IGNORES its abort signal, the collector abandons the hung
 *    dispatch (it is never charged) instead of awaiting it. Once `quorum` seats have
 *    responded, the collector resolves early and aborts the stragglers.
 *  - **No cap overshoot (LOW-A).** Before dispatching a seat the collector RESERVES a
 *    per-turn estimate against the {@link RunGovernor}; once the caps are reached no
 *    further seat is admitted, so a parallel broadcast cannot overshoot by a full round
 *    (the reservation is reconciled to the turn's actual spend when it lands).
 *
 * The collector governs DISPATCH + resolution only. It never routes peer text: every
 * cross-seat relay still flows through the mediated, quoted, injection-scanned
 * `deliverBetweenSeats` path (safety #1/#2) — the caller assembles each seat's prompt
 * BEFORE handing the dispatch thunk here. A seat is handed only a read handle and the
 * abort signal; the collector confers no write authority.
 */
import { runPool } from '../scans/shared/pool.js';
import type { RunGovernor } from './conductor-budget.js';
import type { SeatTurnResult, TurnEstimate } from './conductor-types.js';

/** Default max seats dispatched at once — matches the scan pool's {@link
 *  import('../scans/shared/scan-contracts.js').DEFAULT_CONCURRENCY}. */
export const DEFAULT_SEAT_CONCURRENCY = 6;

/** Default per-seat dispatch timeout (5 min). The generous backstop that guarantees a
 *  hung seat can never stall the board; quorum resolves the common case far sooner. */
export const DEFAULT_SEAT_TIMEOUT_MS = 300_000;

const NO_ESTIMATE: TurnEstimate = { tokens: 0, costUsd: 0 };

/**
 * A cancelable timer seam (default: the global `setTimeout`), mirroring the transcript
 * store's injectable `Clock`, so the per-seat timeout is deterministic in tests.
 * Returns a function that cancels the pending timer.
 */
export type BroadcastClock = (handler: () => void, ms: number) => () => void;

const REAL_CLOCK: BroadcastClock = (handler, ms) => {
  const id = setTimeout(handler, ms);
  return () => clearTimeout(id);
};

/** What the collector hands a seat's dispatch thunk: the shared broadcast id, this
 *  seat's per-seat `seq`, and the abort signal that fires on kill/budget OR when the
 *  collector resolves early on quorum. */
export interface BroadcastDispatch {
  readonly broadcastId: string;
  readonly seq: number;
  readonly signal: AbortSignal;
}

/** How one seat's slot in a broadcast resolved. */
export type SeatBroadcastStatus =
  /** The seat answered before its timeout / the quorum cutoff. */
  | 'responded'
  /** The seat didn't answer in time, was killed, or was superseded by quorum. */
  | 'timed-out'
  /** The seat was NOT dispatched: the hard budget cap was already reached (LOW-A). */
  | 'refused-cap';

/** One seat's outcome from a broadcast. `result` is present iff `responded`. */
export interface SeatBroadcastOutcome<S> {
  readonly seat: S;
  readonly seq: number;
  readonly broadcastId: string;
  readonly status: SeatBroadcastStatus;
  readonly result?: SeatTurnResult;
}

/** The collected result of one broadcast: an outcome per seat (in seat order) plus the
 *  responders projected out (their side-by-side replies are the product). */
export interface BroadcastResult<S> {
  readonly broadcastId: string;
  readonly outcomes: readonly SeatBroadcastOutcome<S>[];
  readonly responders: readonly SeatBroadcastOutcome<S>[];
}

/** The inputs one broadcast is collected from. */
export interface CollectBroadcastInput<S extends { readonly seatId: string }> {
  /** The shared id every reply in this broadcast carries (grouping side-by-side replies). */
  readonly broadcastId: string;
  /** The seats to dispatch to, in preset order (their `seq` is their index here). */
  readonly seats: readonly S[];
  /** The run governor the per-turn reservation is charged against (LOW-A). */
  readonly governor: RunGovernor;
  /**
   * Dispatch ONE seat's turn. The collector owns concurrency, the per-seat timeout, and
   * the budget reservation; this thunk only maps `(seat, dispatch) → result`. Its
   * `dispatch.signal` MUST be threaded to the driver so kill/quorum/timeout abort the
   * in-flight turn.
   */
  run(seat: S, dispatch: BroadcastDispatch): Promise<SeatTurnResult>;
  /** Max seats dispatched concurrently. Clamped to `≥1`. Default {@link DEFAULT_SEAT_CONCURRENCY}. */
  readonly maxConcurrency?: number;
  /** Per-seat dispatch timeout (ms). Default {@link DEFAULT_SEAT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Responders needed to resolve early; reaching it aborts the stragglers. Clamped to
   *  `[1, seats.length]`. Default: every seat (the per-seat timeout bounds a hung one). */
  readonly quorum?: number;
  /** Per-turn budget reserved before dispatch (LOW-A). Default: zero (the reservation
   *  degrades to a committed-cap gate — a seat is still refused once the cap is reached). */
  readonly estimate?: TurnEstimate;
  /** External abort (kill/budget): in-flight dispatches abort promptly and queued seats
   *  are never dispatched. */
  readonly signal?: AbortSignal;
  /** Injectable timer seam (default: real `setTimeout`). */
  readonly clock?: BroadcastClock;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Resolve when `signal` aborts (immediately if already aborted). */
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Dispatch `broadcastId` to every seat with bounded concurrency and resolve on quorum
 * OR the per-seat timeout. Never rejects and never hangs: every seat settles as
 * `responded`, `timed-out`, or `refused-cap`, and the returned promise resolves once
 * all slots settle (quorum + timeout both bound how long that takes).
 */
export async function collectBroadcast<S extends { readonly seatId: string }>(
  input: CollectBroadcastInput<S>,
): Promise<BroadcastResult<S>> {
  const {
    broadcastId,
    seats,
    governor,
    run,
    estimate = NO_ESTIMATE,
    clock = REAL_CLOCK,
  } = input;

  const concurrency = Math.max(1, input.maxConcurrency ?? DEFAULT_SEAT_CONCURRENCY);
  const timeoutMs = input.timeoutMs ?? DEFAULT_SEAT_TIMEOUT_MS;
  const quorum = clamp(input.quorum ?? seats.length, 1, Math.max(1, seats.length));

  // The internal controller aborts when EITHER the external kill/budget signal fires OR
  // the collector resolves early on quorum — both release in-flight + queued stragglers.
  const internal = new AbortController();
  const abortInternal = (): void => {
    if (!internal.signal.aborted) internal.abort();
  };
  const external = input.signal;
  const onExternalAbort = (): void => abortInternal();
  if (external !== undefined) {
    if (external.aborted) abortInternal();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  const outcomes = new Array<SeatBroadcastOutcome<S>>(seats.length);
  let responded = 0;

  const dispatchOne = async (seat: S, seq: number): Promise<void> => {
    // Kill/quorum already reached ⇒ never dispatch this seat.
    if (internal.signal.aborted) {
      outcomes[seq] = { seat, seq, broadcastId, status: 'timed-out' };
      return;
    }
    // LOW-A: reserve budget BEFORE dispatch. A refused reservation means the hard cap is
    // already reached (committed + outstanding reservations) — do not dispatch.
    if (!governor.tryReserve(estimate)) {
      outcomes[seq] = { seat, seq, broadcastId, status: 'refused-cap' };
      return;
    }

    // Per-seat abort = the internal signal (kill/quorum) OR this seat's own timeout.
    const seatController = new AbortController();
    const onInternalAbort = (): void => seatController.abort();
    internal.signal.addEventListener('abort', onInternalAbort, { once: true });
    if (internal.signal.aborted) seatController.abort();
    const cancelTimeout = clock(() => seatController.abort(), timeoutMs);

    const dispatch: BroadcastDispatch = {
      broadcastId,
      seq,
      signal: seatController.signal,
    };

    // Invoke the dispatch thunk under a guard that converts a SYNCHRONOUS throw into an
    // aborted (non-response) settle, exactly like an async rejection (LOW-A, PR #359). A
    // thunk that throws BEFORE returning a Promise would otherwise escape the `.then`
    // below — rejecting `dispatchOne` while the budget stayed RESERVED (leaked) and
    // bubbling out to reject `collectBroadcast`, violating its never-reject contract. Not
    // reachable via `SessionSeatDriver.runTurn` (it always returns a Promise), but the
    // collector holds the never-reject / never-leak line for ANY dispatch thunk.
    const dispatched: Promise<
      { kind: 'responded'; result: SeatTurnResult } | { kind: 'aborted' }
    > = (() => {
      try {
        return run(seat, dispatch).then(
          (result) => ({ kind: 'responded', result }) as const,
          // A dispatch that REJECTS is a non-response, never a rejected board — the driver
          // contract already degrades a seat error to empty, but the collector holds the
          // never-reject line defensively.
          () => ({ kind: 'aborted' }) as const,
        );
      } catch {
        return Promise.resolve({ kind: 'aborted' } as const);
      }
    })();

    // Race the dispatch against the abort/timeout: a driver that IGNORES its signal
    // still cannot stall the collector — the timeout settles the slot and the run is
    // abandoned (never charged).
    const raced = await Promise.race<
      { kind: 'responded'; result: SeatTurnResult } | { kind: 'aborted' }
    >([
      dispatched,
      whenAborted(seatController.signal).then(() => ({ kind: 'aborted' }) as const),
    ]);

    cancelTimeout();
    internal.signal.removeEventListener('abort', onInternalAbort);

    // A response only counts if the seat was NOT aborted first: a driver that resolves
    // EMPTY on abort must land as timed-out, not as a spurious empty response.
    if (raced.kind === 'responded' && !seatController.signal.aborted) {
      governor.settleReservation(estimate, raced.result);
      outcomes[seq] = {
        seat,
        seq,
        broadcastId,
        status: 'responded',
        result: raced.result,
      };
      responded += 1;
      if (responded >= quorum) abortInternal();
    } else {
      governor.releaseReservation(estimate);
      outcomes[seq] = { seat, seq, broadcastId, status: 'timed-out' };
    }
  };

  await runPool(
    seats.map((seat, seq) => ({ seat, seq })),
    concurrency,
    ({ seat, seq }) => dispatchOne(seat, seq),
  );

  if (external !== undefined) external.removeEventListener('abort', onExternalAbort);

  const ordered = outcomes.slice();
  return {
    broadcastId,
    outcomes: ordered,
    responders: ordered.filter((outcome) => outcome.status === 'responded'),
  };
}
