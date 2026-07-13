/**
 * The Conductor's seams and result shapes (issue #350).
 *
 * The Conductor is an ORCHESTRATOR, never a peer: it owns turn-taking, routing, and
 * convergence for one council run and holds the sole {@link ConductorBus} write
 * handle. It has ZERO agent-to-agent command authority — that absence IS the
 * injection firewall (safety non-negotiable #1). A seat is driven ONLY through the
 * provider-neutral {@link SeatDriver} seam below; the Conductor never lets one seat
 * write into another's context (every cross-seat relay goes through the mediated,
 * quoted, injection-scanned {@link ConductorBus.deliverBetweenSeats}, funneled by
 * `peer-context.ts`).
 *
 * The seam is deliberately narrow so the whole state machine + its safety invariants
 * are unit-testable with deterministic FAKE seats — no live provider call. The
 * production seam is `session-seat-driver.ts`.
 */
import type {
  CouncilSeat,
  DebateSeatRole,
  DebateStage,
  DebateTranscriptEntry,
  TokenUsage,
} from '@nightcore/contracts';

import type { CouncilPresetIssue } from './preset-validator.js';

/**
 * A seat's read-only context handed to the {@link SeatDriver}. `view` is the
 * READ-ONLY {@link import('./bus.js').SeatBusView} — a seat can observe the moderated
 * transcript but has no method to write it (safety #1). `id` is SYSTEM-MINTED by the
 * Conductor from the preset, never agent-supplied (safety LOW: the id is interpolated
 * into the quote fence tag).
 */
export interface SeatContext {
  readonly seatId: string;
  readonly role: DebateSeatRole;
  readonly model: string;
}

/** One turn the Conductor asks a seat to take. `prompt` is fully assembled by the
 *  Conductor — for a Debate turn it contains ONLY quoted+scanned peer content (never
 *  raw peer output). `signal` aborts on kill/budget so a cooperative driver bails. */
export interface SeatTurnRequest {
  readonly seat: SeatContext;
  readonly stage: DebateStage;
  readonly prompt: string;
  /** The run's working directory (a seat session's cwd). Absent ⇒ the process cwd. */
  readonly cwd?: string;
  /** Aborts when the run is killed or the budget is exhausted mid-flight. */
  readonly signal: AbortSignal;
}

/** What one seat turn produced: its text plus the spend to charge the run budget. */
export interface SeatTurnResult {
  /** The seat's output text. Recorded onto the bus as the seat's own `message`. */
  readonly content: string;
  /** Token usage for this turn (charged against `budget.maxTotalTokens`). */
  readonly usage: TokenUsage;
  /** Cost in USD for this turn (charged against `budget.maxCostUsd`). */
  readonly costUsd: number;
}

/**
 * The provider-neutral seam the Conductor drives a seat through. ONE method: run a
 * turn and return its output. The Conductor owns the prompt (including the mediated
 * peer context) and the transcript; the driver only maps `prompt → output`. Fakes
 * implement this for the state-machine + safety tests; `SessionSeatDriver` implements
 * it over the real session path.
 */
export interface SeatDriver {
  runTurn(request: SeatTurnRequest): Promise<SeatTurnResult>;
}

/** How a council run terminated. */
export type CouncilRunStatus =
  /** Reached Converge and parked a decision for the human judge (the P1 happy path). */
  | 'converged'
  /** The kill switch halted the run (safety #4). */
  | 'killed'
  /** A hard budget/round cap halted the run (safety #4) — see `haltedBy`. */
  | 'budget-exhausted'
  /** The preset failed `validateCouncilPreset` at Frame — see `issues`. Nothing ran. */
  | 'invalid-preset'
  /** An unexpected error crashed the run (degrade-not-throw). */
  | 'failed';

/** Which hard cap tripped a `budget-exhausted` halt. */
export type BudgetHaltCause = 'maxRounds' | 'maxTotalTokens' | 'maxCostUsd';

/** One seat's final position, carried into the human judge's parked decision. Its
 *  `content` is the seat's OWN output (the seat authored it), quoted only when it is
 *  relayed to ANOTHER seat — a seat reading its own position back is not a cross-seat
 *  relay, so it is not fenced here. */
export interface SeatPosition {
  readonly seatId: string;
  readonly role: DebateSeatRole;
  readonly content: string;
}

/**
 * The parked Converge decision the HUMAN judge resolves (safety #7: the human is the
 * terminal authority). P1 has NO agent-judge and NO vote — the Conductor stops here
 * and surfaces the seats' final positions for a human to accept/reject. Wiring the
 * human's resolution to the InteractionDock is the canvas slice (#352); this slice
 * produces the decision to be resolved.
 */
export interface PendingConvergeDecision {
  readonly councilRunId: string;
  /** The success criterion the human weighs the positions against. */
  readonly successCriterion: string;
  /** Each seat's final position, side-by-side (disagreement is the product). */
  readonly positions: readonly SeatPosition[];
}

/** Running spend totals for a council run. */
export interface CouncilRunUsage {
  readonly totalTokens: number;
  readonly costUsd: number;
  /** Debate rounds actually executed (0 if the run halted before Debate). */
  readonly rounds: number;
}

/**
 * The terminal outcome of a council run. The full append-only transcript is always
 * returned (auditable + replayable — safety #7), regardless of status.
 */
export interface CouncilRunResult {
  readonly councilRunId: string;
  readonly status: CouncilRunStatus;
  readonly transcript: readonly DebateTranscriptEntry[];
  readonly usage: CouncilRunUsage;
  /** Present when `status === 'converged'`: the decision parked for the human judge. */
  readonly pendingDecision?: PendingConvergeDecision;
  /** Present when `status === 'invalid-preset'`: why the preset was rejected. */
  readonly issues?: readonly CouncilPresetIssue[];
  /** Present when `status === 'budget-exhausted'`: which cap tripped. */
  readonly haltedBy?: BudgetHaltCause;
}

/** The seats a run drives, in preset order. */
export type CouncilSeatList = readonly CouncilSeat[];
