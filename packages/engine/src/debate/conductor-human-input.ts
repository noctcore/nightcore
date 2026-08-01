/**
 * CONDUCTOR-MEDIATED HUMAN INPUT (issue #361) — broadcast-all / DM-one / steer-stage.
 *
 * The #352 canvas shipped these three controls DISABLED on purpose: the only existing way
 * to push text at a running agent is `send-input` → `SessionRunner.streamInput`, which
 * hands the text to the provider as a raw user turn. Using it here would have handed a
 * SURFACE direct write authority over a seat (violating safety non-negotiable #1 — the
 * conductor is the sole bus writer, seats have zero direct-to-seat authority) and
 * delivered human prose to a coding agent as a bare INSTRUCTION (violating #2 — every
 * text that crosses into a seat's context is quoted + injection-scanned first).
 *
 * So human input takes the SAME road every cross-seat text already takes:
 *
 *   human message → Conductor → ConductorBus.deliverBetweenSeats
 *                             → scanForInjection + quoted untrusted fence
 *                             → recorded `delivery` entry (append-only, safety #7)
 *                             → staged for the target seat's NEXT mediated turn
 *
 * There is deliberately NO import of the session/`streamInput` path in this module or in
 * anything it reaches — `council-safety.test.ts` walks the static import graph and fails
 * if one ever appears.
 *
 * **Fan-out.** A `broadcast` does NOT open a second seat-dispatch path. It stages the same
 * quoted delivery for each live seat, and the seats then receive it on the debate loop's
 * EXISTING per-round {@link import('./broadcast-collector.js').collectBroadcast} fan-out
 * (`debate-round.ts`) — the one place a council dispatches N seats at once, with its
 * bounded concurrency, per-seat timeout, quorum and budget reservation intact. Dispatching
 * a second concurrent broadcast from here would race the in-flight round and bypass the
 * governor's round accounting.
 *
 * **Steering.** `steer` is the human's directive to the CONDUCTOR, not to a seat: it asks
 * the Debate stage to end at its next checkpoint and route to Converge. That is a STRICT
 * SHORTENER — like the #350 stability stop and the #372 no-progress stop, it can only end
 * a run sooner, never extend it (safety #4). Its message is still relayed quoted+scanned
 * to every live seat, so the reason is on the record (and reaches the seats if a round is
 * still in flight).
 */
import type { CouncilHumanInputMode, DebateStage } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import { type ConductorBus, type DeliveryOutcome, HUMAN_JUDGE_SEAT_ID } from './bus.js';
import type { SeatContext } from './conductor-types.js';

/** The seat id a human-authored bus write is recorded under. Reuses the bus's reserved
 *  human id (the Converge verdict's author) — mid-debate input and the terminal verdict
 *  come from the SAME human, so the transcript attributes them to one author. */
export const HUMAN_INPUT_SEAT_ID = HUMAN_JUDGE_SEAT_ID;

/** The stage a human message is staged into. Human input lands in DEBATE and only there:
 *  Propose is deliberately BLIND (no peer or human content may enter a Propose prompt, or
 *  the diversity the whole council rests on collapses), and Converge belongs to the #353
 *  gavel. */
const HUMAN_INPUT_STAGE: DebateStage = 'debate';

/** One human message addressed to a live run. Mirrors the `send-council-human-input`
 *  command contract. */
export interface HumanInputDirective {
  readonly mode: CouncilHumanInputMode;
  /** The single recipient — REQUIRED for `direct`, ignored otherwise. */
  readonly seatId?: string;
  /** The human's raw message. NEVER handed to a seat as-is; it is quoted + scanned first. */
  readonly message: string;
}

/**
 * The QUOTED, injection-scanned human text waiting for each seat's next mediated turn.
 *
 * It holds only post-`deliverBetweenSeats` renderings — the raw human message never enters
 * this queue, so there is no code path that could hand a seat the unquoted text even by
 * mistake. Drained (and cleared) when the debate loop assembles the seat's prompt, so a
 * message is delivered at most once.
 */
export class HumanInputQueue {
  private readonly pending = new Map<string, string[]>();

  /** Stage one QUOTED delivery for `seatId`'s next turn. */
  enqueue(seatId: string, quotedText: string): void {
    const queued = this.pending.get(seatId);
    if (queued === undefined) this.pending.set(seatId, [quotedText]);
    else queued.push(quotedText);
  }

  /** Take everything staged for `seatId` (clearing it), joined for prompt embedding.
   *  Returns `''` when nothing is staged. */
  drain(seatId: string): string {
    const queued = this.pending.get(seatId);
    if (queued === undefined || queued.length === 0) return '';
    this.pending.delete(seatId);
    return queued.join('\n\n');
  }

  /** Whether anything is staged for `seatId` (test/introspection helper). */
  has(seatId: string): boolean {
    return (this.pending.get(seatId)?.length ?? 0) > 0;
  }
}

/**
 * The live handles a human-input directive needs to reach a RUNNING run: its mediated,
 * observer-wrapped bus (so every delivery streams + audits), the run's seats in preset
 * order (an unknown recipient is refused), the staging queue the debate loop drains, and
 * the steer latch. Set at Frame, cleared when the run leaves the driving loop — so a
 * directive for an unknown, finished, or parked-at-Converge run is a refused no-op.
 */
export interface HumanInputRuntime {
  readonly bus: ConductorBus;
  /** The run's seats in preset order — the broadcast target set + the `direct` whitelist. */
  readonly seatIds: readonly string[];
  readonly queue: HumanInputQueue;
  /** Latched by a `steer` directive; read by the debate loop between rounds. */
  steerRequested: boolean;
}

/** The outcome of a human-input directive. Refusals are DATA (never a throw), mirroring
 *  {@link import('./council-routing.js').RoutingUpdate} and the fire-and-forget dispatch
 *  every council command uses. */
export interface HumanInputUpdate {
  readonly ok: boolean;
  /** Why the directive was refused, when `ok` is false. */
  readonly reason?: string;
  /** The seats the message was staged for, in preset order, when `ok` is true. */
  readonly seatIds?: readonly string[];
  /** The recorded relay outcomes (one per recipient), each carrying its `injectionFlags`
   *  so a caller/test can prove the scan ran on the human's text too. */
  readonly deliveries?: readonly DeliveryOutcome[];
  /** True when the directive also asked the Conductor to advance the stage (`steer`). */
  readonly steered?: boolean;
}

/** Build a run's live human-input handle. The Conductor keeps it for the run's lifetime. */
export function seedHumanInputRuntime(
  bus: ConductorBus,
  seats: readonly SeatContext[],
): HumanInputRuntime {
  return {
    bus,
    seatIds: seats.map((seat) => seat.seatId),
    queue: new HumanInputQueue(),
    steerRequested: false,
  };
}

/** The recipients a directive addresses, or a refusal reason. `direct` is whitelisted
 *  against the run's REAL seats, so a crafted seat id can only ever name an existing seat
 *  or nothing — it can never mint a new delivery target. */
function resolveTargets(
  runtime: HumanInputRuntime,
  directive: HumanInputDirective,
): { seatIds: readonly string[] } | { reason: string } {
  if (directive.mode !== 'direct') return { seatIds: runtime.seatIds };
  const { seatId } = directive;
  if (seatId === undefined || seatId.length === 0) {
    return { reason: 'a direct message must name a seat' };
  }
  if (!runtime.seatIds.includes(seatId)) {
    return { reason: `unknown seat "${seatId}" for this council run` };
  }
  return { seatIds: [seatId] };
}

/** The conductor note recorded beside the relay, so the transcript says WHO was addressed
 *  and WHETHER the scan flagged the human's text — without restating the message itself
 *  (the quoted `delivery` entries are the record of that). */
function directiveNote(
  directive: HumanInputDirective,
  seatIds: readonly string[],
  flagged: number,
): string {
  const audience =
    directive.mode === 'direct'
      ? `seat ${seatIds[0]}`
      : `all ${seatIds.length} live seat(s)`;
  const verb = directive.mode === 'steer' ? 'Human steer' : 'Human input';
  const scan =
    flagged > 0
      ? ` ${flagged} relay(s) tripped the injection scan — delivered quoted regardless, flags on the transcript.`
      : ' Injection-scanned clean.';
  const steer =
    directive.mode === 'steer'
      ? ' The Debate stage will end at its next checkpoint and route to Converge.'
      : '';
  return (
    `${verb} relayed to ${audience} as quoted, injection-scanned data (never as an ` +
    `instruction — issue #361, safety #1/#2).${scan}${steer}`
  );
}

/**
 * Apply a human-input directive to a run in flight (issue #361).
 *
 * Every recipient's copy goes through {@link ConductorBus.deliverBetweenSeats} — the same
 * quote + injection-scan relay a peer seat's text gets — BEFORE anything is staged, and
 * only the returned QUOTED rendering is queued. The raw message is never staged, never
 * embedded in a prompt, and never handed to a session runner. Refused (a no-op that
 * records nothing) for an unknown/finished run, an empty message, or a `direct` message
 * naming a seat this run does not define.
 */
export function applyHumanInputDirective(
  runtime: HumanInputRuntime | undefined,
  councilRunId: string,
  directive: HumanInputDirective,
  logger: Logger | undefined,
): HumanInputUpdate {
  if (runtime === undefined) {
    return { ok: false, reason: 'no active council run to address' };
  }
  const message = directive.message.trim();
  if (message.length === 0) {
    return { ok: false, reason: 'an empty message is not delivered' };
  }
  const targets = resolveTargets(runtime, directive);
  if ('reason' in targets) return { ok: false, reason: targets.reason };
  const { seatIds } = targets;
  if (seatIds.length === 0) {
    return { ok: false, reason: 'this council run has no live seats to address' };
  }

  // The mediated relay — one per recipient. `deliverBetweenSeats` scans + quotes + records
  // BEFORE returning, so `outcome.text` is the ONLY form of the human's words that can
  // reach a prompt. Nothing here can hand a seat `message`.
  const deliveries = seatIds.map((seatId) => {
    const outcome = runtime.bus.deliverBetweenSeats({
      stage: HUMAN_INPUT_STAGE,
      fromSeatId: HUMAN_INPUT_SEAT_ID,
      role: 'human',
      content: message,
    });
    runtime.queue.enqueue(seatId, outcome.text);
    return outcome;
  });

  // A `steer` latches the stage advance for the debate loop to read between rounds. It can
  // only SHORTEN the run (safety #4); there is no directive that extends one.
  if (directive.mode === 'steer') runtime.steerRequested = true;

  const flagged = deliveries.filter((delivery) => delivery.flagged).length;
  runtime.bus.note(
    HUMAN_INPUT_STAGE,
    directiveNote(directive, seatIds, flagged),
  );
  // The message itself is user content and is NEVER logged; only the shape of the
  // directive is (mirroring `resolve_council_converge`'s note handling).
  logger?.info('council human input relayed', {
    councilRunId,
    mode: directive.mode,
    seats: seatIds.length,
    flagged,
  });

  return {
    ok: true,
    seatIds,
    deliveries,
    ...(directive.mode === 'steer' ? { steered: true } : {}),
  };
}
