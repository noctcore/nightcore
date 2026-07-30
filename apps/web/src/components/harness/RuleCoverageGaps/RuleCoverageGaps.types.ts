/** Types for the RuleCoverageGaps panel. */
import type { ConventionDriftStatus, CoverageStatus } from '@/lib/bridge';

import type { ConventionDriftVM, RuleCoverageGapVM } from '../harness.types';
import type { ArmedDriftView } from '../harness-drift.hooks';
import type { DriftDeltaResult } from '../harness-drift-delta';

/** Props for {@link RuleCoverageGaps}: the ENFORCE-lite coverage records for the
 *  displayed run (one per convention) plus the MEASURED drift from the last EnforceRun
 *  (with the run carried forward beside it). Coverage and drift both key on
 *  `conventionFingerprint`; the panel joins them so each convention shows coverage
 *  ("is there a rule?") AND drift ("is it followed?"), and compares the two runs for a
 *  trend. Rendered only in the Enforce destination. */
export interface RuleCoverageGapsProps {
  gaps: RuleCoverageGapVM[];
  /** Measured drift + the carried-forward previous run. An empty `drift` ⇒ not
   *  measured yet — the panel renders the honest "not measured" state, never "clean". */
  drift: ArmedDriftView;
}

/** The per-status tallies + the distinct enforcing-rule count the panel header shows. */
export interface CoverageSummary {
  total: number;
  enforced: number;
  documentedOnly: number;
  unenforced: number;
  /** Distinct enforcing rule ids across every `enforced` record — the "inventory:
   *  N rules found" count, derived from the coverage itself. */
  enforcingRuleCount: number;
}

/** The measured-drift tallies the header shows once an EnforceRun has run. */
export interface DriftSummary {
  clean: number;
  drifted: number;
  errored: number;
  uncheckable: number;
}

/** The drift cell for one convention row — what the join resolved for it:
 *   - `measured`   — a matching drift record exists (render its status + method +
 *                    counts / errorReason; the record's status may itself be any of
 *                    clean/drifted/errored/uncheckable).
 *   - `derived`    — an EnforceRun HAS run, but no armed check covers this convention,
 *                    so the UI derives `uncheckable` (honest — NOT "clean").
 *   - `unmeasured` — no EnforceRun yet (drift empty); the row shows no drift chip and
 *                    the panel carries a "not measured yet" note. */
export type DriftCell =
  | { kind: 'measured'; drift: ConventionDriftVM }
  | { kind: 'derived' }
  | { kind: 'unmeasured' };

/** One convention's joined row: its coverage record + the resolved drift cell. */
export interface CoverageDriftRow {
  gap: RuleCoverageGapVM;
  cell: DriftCell;
}

/** The one-line trend sentence per {@link DriftDeltaResult} blocker — why no
 *  comparison is shown. Never a number the user could read as a measured trend. */
export const DRIFT_DELTA_BLOCKER_COPY = {
  'no-earlier-run':
    'No earlier measured run to compare against — run the armed checks again to start a trend.',
  'run-not-diffable':
    'This run measured no conventions, so there is nothing to compare it against.',
  'ground-changed':
    'The armed drift checks changed since the last measured run, so the two runs measured different ground — no trend is shown rather than a misleading one.',
} as const satisfies Record<string, string>;

/** The resolved view model {@link RuleCoverageGaps} renders from. */
export interface RuleCoverageGapsViewModel {
  summary: CoverageSummary;
  /** The drift tallies (only meaningful when `driftMeasured`). */
  driftSummary: DriftSummary;
  /** The run-over-run comparison against the carried-forward run, OR the reason there
   *  isn't one (#279). Rendered only once `driftMeasured`. */
  delta: DriftDeltaResult;
  /** The joined rows ordered actionable-first (by coverage status). */
  ordered: CoverageDriftRow[];
  /** Whether an EnforceRun has measured drift (≥1 drift record). Drives the header
   *  drift tallies and the "not measured yet" note. */
  driftMeasured: boolean;
  /** Whether there is anything to render (a run with coverage). */
  hasCoverage: boolean;
}

/** The display order weight per status (lower = shown first — the actionable gaps). */
export const COVERAGE_STATUS_ORDER: Record<CoverageStatus, number> = {
  unenforced: 0,
  'documented-only': 1,
  enforced: 2,
};

/** The drift statuses that carry site counts — a `clean`/`drifted` chip must ALWAYS
 *  render its `method` + `X/Y sites` (the non-negotiable fail-visible product rule). */
export const DRIFT_STATUS_WITH_COUNTS: ReadonlySet<ConventionDriftStatus> = new Set<ConventionDriftStatus>([
  'clean',
  'drifted',
]);
