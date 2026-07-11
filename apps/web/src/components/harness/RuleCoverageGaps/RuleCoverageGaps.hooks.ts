/** Derivation for the RuleCoverageGaps panel: the per-status coverage summary, the
 *  actionable-first ordering, and the JOIN of each convention's coverage record to
 *  its measured drift (by `conventionFingerprint`). Pure (no run state) — coverage +
 *  drift come in as props; kept in the hook so the component body stays a thin render
 *  shell. Coverage answers "is there a rule?"; drift answers "is it followed?". */
import { useMemo } from 'react';

import type { ConventionDriftVM, RuleCoverageGapVM } from '../harness.types';
import {
  COVERAGE_STATUS_ORDER,
  type DriftCell,
  type DriftSummary,
  type RuleCoverageGapsViewModel,
} from './RuleCoverageGaps.types';

/** Resolve the drift cell for one convention: a matching measured record, else a
 *  derived `uncheckable` when SOME drift was measured, else `unmeasured`. */
function resolveCell(
  gap: RuleCoverageGapVM,
  driftByFingerprint: Map<string, ConventionDriftVM>,
  driftMeasured: boolean,
): DriftCell {
  const match = driftByFingerprint.get(gap.conventionFingerprint);
  if (match !== undefined) return { kind: 'measured', drift: match };
  return driftMeasured ? { kind: 'derived' } : { kind: 'unmeasured' };
}

/** Tally the resolved cells into the header drift summary (derived + measured
 *  `uncheckable` both count as uncheckable). */
function summarizeDrift(cells: DriftCell[]): DriftSummary {
  const summary: DriftSummary = { clean: 0, drifted: 0, errored: 0, uncheckable: 0 };
  for (const cell of cells) {
    if (cell.kind === 'derived') {
      summary.uncheckable += 1;
    } else if (cell.kind === 'measured') {
      if (cell.drift.status === 'uncheckable') summary.uncheckable += 1;
      else summary[cell.drift.status] += 1;
    }
  }
  return summary;
}

/** Resolve the coverage + drift records into the panel's summaries + joined,
 *  actionable-first rows. */
export function useRuleCoverageGaps(
  gaps: RuleCoverageGapVM[],
  drift: ConventionDriftVM[],
): RuleCoverageGapsViewModel {
  return useMemo(() => {
    const enforcingRules = new Set<string>();
    let enforced = 0;
    let documentedOnly = 0;
    let unenforced = 0;
    for (const gap of gaps) {
      if (gap.status === 'enforced') {
        enforced += 1;
        for (const rule of gap.enforcedBy) enforcingRules.add(rule);
      } else if (gap.status === 'documented-only') {
        documentedOnly += 1;
      } else {
        unenforced += 1;
      }
    }

    // Index drift by its join key. `driftMeasured` gates the honest empty state: with
    // ≥1 record an EnforceRun ran, so unmatched conventions derive `uncheckable`;
    // with none, they read "not measured yet" (never a fake "clean").
    const driftByFingerprint = new Map<string, ConventionDriftVM>();
    for (const d of drift) driftByFingerprint.set(d.conventionFingerprint, d);
    const driftMeasured = drift.length > 0;

    // Stable sort: actionable coverage gaps first, then keep the incoming order.
    const ordered = gaps
      .map((gap, index) => ({ gap, index }))
      .sort((a, b) => {
        const byStatus =
          COVERAGE_STATUS_ORDER[a.gap.status] - COVERAGE_STATUS_ORDER[b.gap.status];
        return byStatus !== 0 ? byStatus : a.index - b.index;
      })
      .map(({ gap }) => ({
        gap,
        cell: resolveCell(gap, driftByFingerprint, driftMeasured),
      }));

    return {
      summary: {
        total: gaps.length,
        enforced,
        documentedOnly,
        unenforced,
        enforcingRuleCount: enforcingRules.size,
      },
      driftSummary: summarizeDrift(ordered.map((row) => row.cell)),
      ordered,
      driftMeasured,
      hasCoverage: gaps.length > 0,
    };
  }, [gaps, drift]);
}
