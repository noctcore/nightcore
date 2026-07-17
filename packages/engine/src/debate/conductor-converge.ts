/**
 * The Council Converge stage's ORCHESTRATION (issue #353 park + human gavel; issue #365
 * OBJECTIVE GATE) — split out of `conductor.ts` so the state machine stays under the
 * engine file-size cap.
 *
 * Converge runs the OBJECTIVE GATE first when one is wired ({@link runConverge}) — a
 * DETERMINISTIC tests/repro/build check whose RED verdict OVERRIDES debate consensus
 * (safety non-negotiable #6) — then PARKS the seats' final positions for the HUMAN judge
 * (safety #7 — the human is the ultimate authority; no agent-judge, no vote). The human
 * later closes the run with a verdict; over a RED gate a plain `accept` is refused unless
 * the human explicitly overrides it. Both the gate verdict and the human verdict are
 * recorded onto the append-only transcript through the SAME observer-wrapped {@link
 * ConductorBus} every other entry uses — never a direct transcript-store write from the
 * surface (safety #1, the injection firewall) — which also streams them over `nc:debate`.
 * Clearing the park closes the run.
 */
import type { DebateTranscriptEntry } from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

import type { ConductorBus } from './bus.js';
import type { CouncilRunInput } from './conductor.js';
// Type-only imports (erased at runtime — no import cycle): the Converge orchestration
// consumes the run's inputs the Conductor already assembled, and the Build stage's
// outcome (the worktree the objective gate judges).
import type { BuildOutcome } from './conductor-build.js';
import type {
  ConvergeDecision,
  ConvergeResolution,
  PendingConvergeDecision,
  SeatContext,
} from './conductor-types.js';
import type { ObjectiveGate, ObjectiveGateVerdict } from './objective-gate.js';

/** A run parked at Converge, awaiting the human judge's verdict. Holds the run's
 *  OBSERVER-wrapped bus (so the verdict rides the audit + `nc:debate` fan-out every
 *  entry does) and the positions the human weighs (`accept` must name one). */
export interface ParkedConverge {
  readonly bus: ConductorBus;
  readonly pending: PendingConvergeDecision;
}

/** Inputs for {@link runConverge}. */
export interface RunConvergeInput {
  readonly parked: Map<string, ParkedConverge>;
  /** The run's OBSERVER-wrapped bus — verdict + notes fan out over `nc:debate`. */
  readonly bus: ConductorBus;
  /** The objective gate to run, or `undefined` for a pure-reasoning run (no gate). */
  readonly gate: ObjectiveGate | undefined;
  /** The run's inputs (councilRunId / objective / cwd / preset.successCriterion). */
  readonly run: CouncilRunInput;
  readonly seats: readonly SeatContext[];
  readonly finalOutputs: ReadonlyMap<string, string>;
  readonly rounds: number;
  /** The run's abort signal — a kill/budget halt cancels an in-flight gate check. */
  readonly signal: AbortSignal;
  readonly logger: Logger | undefined;
  /** The Build stage's outcome, when a build ran (issue #366, safety #6). When present
   *  with a `worktreePath`, the objective gate judges the BUILD OUTPUT (it runs its
   *  deterministic build/test check in the writer's isolated worktree), not the run cwd —
   *  a failing gate then REJECTS the build. Absent ⇒ a pure-reasoning run (gate, if any,
   *  runs in the run cwd, as in P1). */
  readonly buildOutput?: BuildOutcome;
}

/**
 * Orchestrate the Converge stage (issue #365, safety #6): run the OBJECTIVE GATE over the
 * seats' final positions when one is wired — a DETERMINISTIC tests/repro/build check whose
 * RED verdict OVERRIDES consensus — then PARK the positions (with the gate verdict) for the
 * human judge, returning the pending decision. The gate is NOT a seat turn: it never
 * charges the run budget; it is threaded the run's abort signal so a kill/budget halt
 * cancels it. Split out of the Conductor so the state-machine file stays under the size cap.
 */
export async function runConverge(
  input: RunConvergeInput,
): Promise<PendingConvergeDecision> {
  const { run } = input;
  let gateVerdict: ObjectiveGateVerdict | undefined;
  if (input.gate !== undefined) {
    // When a Build ran, the gate judges the BUILD OUTPUT: point its deterministic
    // build/test check at the writer's ISOLATED worktree, not the run cwd (safety #6,
    // issue #366) — so a failing build/test REJECTS the build. No build ⇒ the run cwd
    // (P1 pure-reasoning behaviour).
    const gateCwd = input.buildOutput?.worktreePath ?? run.cwd;
    gateVerdict = await input.gate.evaluate({
      councilRunId: run.councilRunId,
      objective: run.objective,
      successCriterion: run.preset.successCriterion,
      ...(gateCwd !== undefined ? { cwd: gateCwd } : {}),
      positions: input.seats.map((seat) => ({
        seatId: seat.seatId,
        role: seat.role,
        content: input.finalOutputs.get(seat.seatId) ?? '',
      })),
      signal: input.signal,
    });
    input.logger?.info('council objective gate evaluated', {
      councilRunId: run.councilRunId,
      passed: gateVerdict.passed,
    });
  }

  return parkConverge({
    parked: input.parked,
    bus: input.bus,
    councilRunId: run.councilRunId,
    seats: input.seats,
    finalOutputs: input.finalOutputs,
    successCriterion: run.preset.successCriterion,
    rounds: input.rounds,
    ...(gateVerdict !== undefined ? { gateVerdict } : {}),
  });
}

/** Inputs for {@link parkConverge}. */
export interface ParkConvergeInput {
  readonly parked: Map<string, ParkedConverge>;
  /** The run's OBSERVER-wrapped bus — kept so the eventual verdict fans out identically. */
  readonly bus: ConductorBus;
  readonly councilRunId: string;
  readonly seats: readonly SeatContext[];
  readonly finalOutputs: ReadonlyMap<string, string>;
  readonly successCriterion: string;
  readonly rounds: number;
  /**
   * The objective gate's verdict for this run (issue #365, safety #6), when one ran. Its
   * result is DETERMINISTIC (a test/repro/build), but it is recorded onto the append-only
   * transcript THROUGH the conductor bus (never a direct store write — safety #1) and
   * rides the parked decision so a RED gate can OVERRIDE consensus at resolution.
   */
  readonly gateVerdict?: ObjectiveGateVerdict;
}

/** Record the objective-gate verdict (when present) + the Converge note, build the
 *  seats' final positions, PARK the run for the human judge, and return the pending
 *  decision to surface on the run result. */
export function parkConverge(input: ParkConvergeInput): PendingConvergeDecision {
  const positions = input.seats.map((seat) => ({
    seatId: seat.seatId,
    role: seat.role,
    content: input.finalOutputs.get(seat.seatId) ?? '',
  }));

  // Record the objective gate's verdict onto the transcript FIRST (safety #6): a red gate
  // is the reason a later `accept` is refused, so its rationale must be auditable. The
  // verdict is trusted deterministic data, but it flows through the mediated bus.
  if (input.gateVerdict !== undefined) {
    const { passed, summary } = input.gateVerdict;
    input.bus.note(
      'converge',
      `Objective gate ${passed ? 'PASSED' : 'FAILED'} — ${summary}` +
        (passed
          ? ' Consensus may stand, pending the human judge.'
          : ' Consensus is OVERRIDDEN: a seat position cannot be adopted unless the' +
            ' human explicitly overrides the gate (safety #6 — objective gates outrank' +
            ' debate).'),
    );
  }

  input.bus.note(
    'converge',
    `Debate closed after ${input.rounds} round(s). ` +
      `Parking ${positions.length} final position(s) for the human judge.`,
  );

  const pending: PendingConvergeDecision = {
    councilRunId: input.councilRunId,
    successCriterion: input.successCriterion,
    positions,
    ...(input.gateVerdict !== undefined ? { gateVerdict: input.gateVerdict } : {}),
  };
  input.parked.set(input.councilRunId, { bus: input.bus, pending });
  return pending;
}

/**
 * Resolve a run's PARKED Converge decision with the human judge's verdict. Records the
 * canonical verdict onto the append-only transcript through the run's mediated bus and
 * clears the park (closing the run). Idempotent: resolving an unknown / already-resolved
 * run is a refused no-op, and a malformed verdict (an `accept` naming no parked seat, a
 * `judge` with no ruling) is refused WITHOUT recording anything (the run stays parked).
 *
 * OBJECTIVE-GATE OVERRIDE (issue #365, safety #6): when the parked decision's objective
 * gate is RED, an `accept` — adopting a seat's debated answer — is refused unless the
 * human explicitly sets {@link ConvergeDecision.overrideGate}. The gate outranks the
 * debate by default; the human's deliberate override is the only thing that supersedes
 * it (the human is the ultimate authority — safety #7). `reject`/`judge` are unaffected.
 */
export function resolveParkedConverge(
  parked: Map<string, ParkedConverge>,
  councilRunId: string,
  decision: ConvergeDecision,
  readTranscript: () => readonly DebateTranscriptEntry[],
  logger?: Logger,
): ConvergeResolution {
  const entry = parked.get(councilRunId);
  if (entry === undefined) {
    return { ok: false, reason: 'no parked Converge decision for this run' };
  }

  const gateBlock = gateOverridesAccept(decision, entry.pending);
  if (gateBlock !== null) return { ok: false, reason: gateBlock };

  const rendered = renderVerdict(decision, entry.pending);
  if (!rendered.ok) return { ok: false, reason: rendered.reason };

  const verdict = entry.bus.recordVerdict(rendered.content);
  parked.delete(councilRunId);
  logger?.info('council converge resolved by human judge', {
    councilRunId,
    decision: decision.kind,
  });
  return { ok: true, entry: verdict, transcript: readTranscript() };
}

/**
 * The refusal reason when a RED objective gate blocks this verdict, or `null` when the
 * verdict may proceed (issue #365, safety #6). Only an `accept` — adopting a seat's
 * debated position — is blocked by a failing gate, and only when the human did NOT set
 * `overrideGate`. `reject`/`judge` never adopt the debate's answer, and a passed/absent
 * gate never blocks. Refusing here (before {@link renderVerdict}) records NOTHING, so the
 * run stays parked for the human to reject, rule, or deliberately override.
 */
function gateOverridesAccept(
  decision: ConvergeDecision,
  pending: PendingConvergeDecision,
): string | null {
  if (decision.kind !== 'accept') return null;
  if (pending.gateVerdict === undefined || pending.gateVerdict.passed) return null;
  if (decision.overrideGate === true) return null;
  return (
    `objective gate is red (${pending.gateVerdict.summary}); adopting a seat's ` +
    'position requires an explicit gate override (safety #6 — objective gates ' +
    'outrank debate)'
  );
}

/** Validate a verdict against the parked positions and render its canonical, auditable
 *  transcript content. Refuses an `accept` that names no parked seat and a `judge` with
 *  no ruling — the two verdicts that carry required data. */
function renderVerdict(
  decision: ConvergeDecision,
  pending: PendingConvergeDecision,
): { ok: true; content: string } | { ok: false; reason: string } {
  const note = decision.note?.trim();
  switch (decision.kind) {
    case 'accept': {
      const position = pending.positions.find((p) => p.seatId === decision.seatId);
      if (position === undefined) {
        return {
          ok: false,
          reason: `accept names an unknown seat "${decision.seatId ?? ''}"`,
        };
      }
      // Audit a deliberate override of a red objective gate (safety #6 → #7): the human
      // is the ultimate authority, but adopting the debate over a failing gate is
      // recorded as an explicit override, never silently. Keyed on the EXPLICIT
      // `overrideGate` flag (defense-in-depth, issue #370 / #375 gate LOW) — NOT merely
      // on the gate being red — so that as new convergence modes reach this path, only a
      // deliberate human override is audited: `gateOverridesAccept` above already refuses
      // a red-gate accept that did NOT set the flag, so an un-flagged accept can never
      // reach here over a red gate, and a flag set on a green/absent gate (nothing to
      // override) is never mis-audited. The red-gate guard keeps the message accurate.
      const overrodeGate =
        decision.overrideGate === true &&
        pending.gateVerdict !== undefined &&
        !pending.gateVerdict.passed;
      return {
        ok: true,
        content:
          `Human verdict — ACCEPT: adopted seat "${position.seatId}" (${position.role}).` +
          (overrodeGate
            ? ` OVERRODE the red objective gate (${pending.gateVerdict!.summary}).`
            : '') +
          (note ? ` Reason: ${note}` : ''),
      };
    }
    case 'reject':
      return {
        ok: true,
        content:
          'Human verdict — REJECT: no position adopted.' +
          (note ? ` Reason: ${note}` : ''),
      };
    case 'judge':
      if (note === undefined || note.length === 0) {
        return { ok: false, reason: 'judge requires a ruling note' };
      }
      return { ok: true, content: `Human verdict — RULING: ${note}` };
  }
}
