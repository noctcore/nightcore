/**
 * The Council preset validator (issue #349) — enforces the P1 invariants a
 * structural zod parse deliberately does NOT.
 *
 * These invariants are correctness requirements from the design, not style checks:
 *
 *  - **≥2 DISTINCT models across the seats.** Homogeneous seats produce sycophantic
 *    agreement, not real disagreement — heterogeneity is the entire point of a
 *    council (design "When *not* to use it": "Homogeneous seats"). A same-model
 *    preset is REJECTED.
 *  - **≤4 seats** (and at least one). P1 caps the council size.
 *  - **Present, positive budget/round caps** (safety non-negotiable #4: hard caps +
 *    a kill switch, never "run until they agree"). The conductor's kill/early-stop
 *    reads these, so a missing or non-positive cap is rejected.
 *  - **Seat roles are DEBATING roles only** (`proposer | critic | judge`). The
 *    `conductor`/`human` roles in {@link DebateSeatRoleSchema} are RESERVED for the
 *    orchestrator and the terminal human authority — a seat claiming one is a
 *    verdict-forgery footgun (a `human`-role seat message reads like the human
 *    gavel's converge note). The conductor-only write surface + the
 *    `kind:'note'`/`stage:'converge'` gates already defuse it, but the validator
 *    rejects a reserved seat role up front (defense-in-depth, PR #362 carry-forward).
 *
 * The result is a TYPED value, never a throw: callers (the future conductor, a
 * preset editor) surface `issues` to the user instead of catching an exception.
 * This complements — it does not replace — `CouncilPresetSchema.parse`, which owns
 * structural validation; the caps are re-checked here so a preset hand-built in TS
 * (bypassing `parse`) is caught too.
 */
import type { CouncilPreset, DebateSeatRole } from '@nightcore/contracts';

/** The maximum number of seats a P1 council preset may define. */
export const COUNCIL_MAX_SEATS = 4;
/** The minimum number of DISTINCT models required across a council's seats. */
export const COUNCIL_MIN_DISTINCT_MODELS = 2;

/** The asymmetric roles a DEBATING seat may hold. `conductor` (the orchestrator) and
 *  `human` (the terminal gavel) are RESERVED — never a seat (PR #362 carry-forward). */
export const COUNCIL_SEAT_ROLES = ['proposer', 'critic', 'judge'] as const;

/** Whether `role` is a role a debating seat is allowed to hold. */
function isSeatRole(role: DebateSeatRole): boolean {
  return (COUNCIL_SEAT_ROLES as readonly DebateSeatRole[]).includes(role);
}

/**
 * The seats that PROPOSE + DEBATE — every seat except the dedicated `judge` seat (issue
 * #370). A `judge`-role seat is the convergence judge for `judge-agent` presets: it rules
 * on the debaters' positions at Converge and does NOT take a debating turn (a judge that
 * proposed a position would be ruling on its own). For `human`/`vote` presets there is no
 * judge seat, so this is every seat (P1 behaviour is unchanged).
 */
export function debatingSeats<T extends { readonly role: DebateSeatRole }>(
  seats: readonly T[],
): readonly T[] {
  return seats.filter((seat) => seat.role !== 'judge');
}

/** The dedicated judge seat for a `judge-agent` preset, or `undefined` when none is
 *  defined. The validator guarantees a `judge-agent` preset has EXACTLY one, so callers
 *  on the validated path can treat a present value as the sole judge. */
export function judgeSeat<T extends { readonly role: DebateSeatRole }>(
  seats: readonly T[],
): T | undefined {
  return seats.find((seat) => seat.role === 'judge');
}

/** The minimum debating seats a `vote` convergence needs (a quorum needs voters). */
export const COUNCIL_MIN_VOTE_SEATS = 2;

/** A machine-branchable code for one preset-validation failure. */
export type CouncilPresetIssueCode =
  | 'no-seats'
  | 'too-many-seats'
  | 'insufficient-model-diversity'
  | 'reserved-seat-role'
  | 'missing-budget-cap'
  | 'non-positive-budget-cap'
  /** `judge-agent` convergence needs EXACTLY one `judge`-role seat (issue #370). */
  | 'judge-agent-requires-one-judge-seat'
  /** `judge-agent` convergence needs at least one debating (non-judge) seat (#370). */
  | 'judge-agent-requires-debaters'
  /** `vote` convergence needs at least two debating seats to tally a quorum (#370). */
  | 'vote-requires-debaters'
  /** A `build` stage must declare an `objectiveGate` — a write is never un-gated (#367,
   *  safety #6: an objective gate must judge the build output). */
  | 'build-stage-requires-objective-gate'
  /** The reproduce-first `repro` gate needs a `build` stage — the write is what turns the
   *  repro RED → GREEN, so a `repro` preset without a build could never pass (#367). */
  | 'objective-gate-requires-build-stage';

/** One reason a preset is invalid — a code to branch on and a human-readable message. */
export interface CouncilPresetIssue {
  code: CouncilPresetIssueCode;
  message: string;
}

/** The validator's typed verdict. Every failure is collected so a caller can show
 *  all of them at once rather than one-at-a-time. */
export type CouncilPresetValidation =
  | { valid: true }
  | { valid: false; issues: CouncilPresetIssue[] };

/** The budget caps, checked in a fixed order. */
const BUDGET_CAPS = ['maxRounds', 'maxTotalTokens', 'maxCostUsd'] as const;

/** A cap is invalid unless it is a finite, strictly-positive number. Typed to accept
 *  `undefined` so a preset hand-built in TS with a missing cap is caught, not just a
 *  parsed one. */
function checkCap(
  name: string,
  value: number | undefined,
  issues: CouncilPresetIssue[],
): void {
  if (value === undefined || !Number.isFinite(value)) {
    issues.push({
      code: 'missing-budget-cap',
      message: `Budget cap "${name}" is required and must be a finite number.`,
    });
    return;
  }
  if (value <= 0) {
    issues.push({
      code: 'non-positive-budget-cap',
      message: `Budget cap "${name}" must be positive; got ${value}.`,
    });
  }
}

/**
 * Validate a council preset against the P1 invariants. Returns `{ valid: true }` or
 * `{ valid: false, issues }` — never throws. Collects every failure.
 */
export function validateCouncilPreset(
  preset: CouncilPreset,
): CouncilPresetValidation {
  const issues: CouncilPresetIssue[] = [];

  const seatCount = preset.seats.length;
  if (seatCount === 0) {
    issues.push({
      code: 'no-seats',
      message: 'A council preset must define at least one seat.',
    });
  }
  if (seatCount > COUNCIL_MAX_SEATS) {
    issues.push({
      code: 'too-many-seats',
      message: `A council preset may define at most ${COUNCIL_MAX_SEATS} seats; got ${seatCount}.`,
    });
  }

  const distinctModels = new Set(preset.seats.map((seat) => seat.model));
  if (distinctModels.size < COUNCIL_MIN_DISTINCT_MODELS) {
    issues.push({
      code: 'insufficient-model-diversity',
      message:
        `A council needs at least ${COUNCIL_MIN_DISTINCT_MODELS} distinct models across its seats ` +
        `(homogeneous seats produce sycophantic agreement, not real disagreement); ` +
        `got ${distinctModels.size}.`,
    });
  }

  // Reserved-role guard (PR #362): a seat may only hold a DEBATING role. `conductor`
  // and `human` are reserved for the orchestrator + the terminal gavel; a seat
  // claiming one could forge a verdict-shaped contribution.
  for (const seat of preset.seats) {
    if (!isSeatRole(seat.role)) {
      issues.push({
        code: 'reserved-seat-role',
        message:
          `Seat "${seat.id}" has reserved role "${seat.role}"; a debating seat may only be ` +
          `one of ${COUNCIL_SEAT_ROLES.join(' | ')} (conductor/human are reserved for the ` +
          `orchestrator and the terminal human authority).`,
      });
    }
  }

  checkConvergence(preset, issues);
  checkObjective(preset, issues);

  for (const cap of BUDGET_CAPS) {
    checkCap(cap, preset.budget[cap], issues);
  }

  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}

/**
 * Enforce the objective-preset invariants (issue #367, safety #6). An OBJECTIVE preset
 * couples a `build` stage with an `objectiveGate` gate, and neither is valid alone:
 *
 *  - **A `build` stage requires an `objectiveGate`.** A council's write must always be
 *    judged by a deterministic gate — a build with no objective gate could be adopted on
 *    debate consensus alone, which is exactly what safety #6 forbids. So a `build` stage
 *    without a gate is REJECTED.
 *  - **The `repro` gate requires a `build` stage.** Reproduce-first means the Build turns a
 *    RED repro GREEN; a `repro` preset with no `build` stage can never flip the repro, so
 *    its gate could never pass. A `repro` gate without a build is REJECTED.
 *
 * A pure-reasoning preset (`research`: no build, no gate) satisfies both trivially.
 */
function checkObjective(
  preset: CouncilPreset,
  issues: CouncilPresetIssue[],
): void {
  const hasBuildStage = preset.stages.some((step) => step.stage === 'build');

  if (hasBuildStage && preset.objectiveGate === undefined) {
    issues.push({
      code: 'build-stage-requires-objective-gate',
      message:
        'A preset with a `build` stage must declare an `objectiveGate`: a council write ' +
        'must be judged by a deterministic objective gate, never adopted on debate ' +
        'consensus alone (safety #6 — objective gates outrank debate).',
    });
  }

  if (preset.objectiveGate === 'repro' && !hasBuildStage) {
    issues.push({
      code: 'objective-gate-requires-build-stage',
      message:
        'The reproduce-first `repro` gate needs a `build` stage: the Build is what turns ' +
        'the repro from RED to GREEN, so a `repro` preset without a build could never pass.',
    });
  }
}

/**
 * Enforce the seat shape a non-human convergence mode requires (issue #370). `human`
 * imposes nothing new (P1). `judge-agent` needs EXACTLY one dedicated `judge` seat to
 * rule plus at least one debating seat for it to rule ON. `vote` needs at least two
 * debating seats so a quorum is meaningful. A `judge` seat under `human`/`vote` stays
 * VALID (it is simply unused) so the mode change is backward-compatible — only
 * `judge-agent` requires one.
 */
function checkConvergence(
  preset: CouncilPreset,
  issues: CouncilPresetIssue[],
): void {
  const judges = preset.seats.filter((seat) => seat.role === 'judge');
  const debaters = debatingSeats(preset.seats);

  if (preset.convergence === 'judge-agent') {
    if (judges.length !== 1) {
      issues.push({
        code: 'judge-agent-requires-one-judge-seat',
        message:
          `judge-agent convergence needs EXACTLY one seat with role "judge" (the ` +
          `dedicated judge that rules on the debate); got ${judges.length}.`,
      });
    }
    if (debaters.length === 0) {
      issues.push({
        code: 'judge-agent-requires-debaters',
        message:
          'judge-agent convergence needs at least one debating (non-judge) seat for ' +
          'the judge to rule on.',
      });
    }
  }

  if (preset.convergence === 'vote' && debaters.length < COUNCIL_MIN_VOTE_SEATS) {
    issues.push({
      code: 'vote-requires-debaters',
      message:
        `vote convergence needs at least ${COUNCIL_MIN_VOTE_SEATS} debating seats to ` +
        `tally a quorum; got ${debaters.length}.`,
    });
  }
}
