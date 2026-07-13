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
 *
 * The result is a TYPED value, never a throw: callers (the future conductor, a
 * preset editor) surface `issues` to the user instead of catching an exception.
 * This complements — it does not replace — `CouncilPresetSchema.parse`, which owns
 * structural validation; the caps are re-checked here so a preset hand-built in TS
 * (bypassing `parse`) is caught too.
 */
import type { CouncilPreset } from '@nightcore/contracts';

/** The maximum number of seats a P1 council preset may define. */
export const COUNCIL_MAX_SEATS = 4;
/** The minimum number of DISTINCT models required across a council's seats. */
export const COUNCIL_MIN_DISTINCT_MODELS = 2;

/** A machine-branchable code for one preset-validation failure. */
export type CouncilPresetIssueCode =
  | 'no-seats'
  | 'too-many-seats'
  | 'insufficient-model-diversity'
  | 'missing-budget-cap'
  | 'non-positive-budget-cap';

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

  for (const cap of BUDGET_CAPS) {
    checkCap(cap, preset.budget[cap], issues);
  }

  return issues.length === 0 ? { valid: true } : { valid: false, issues };
}
