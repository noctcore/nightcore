/**
 * Pure builders for the Scorecard RESULTS grid rows, split out of
 * `ScorecardView.hooks` so the controller stays under the file-size cap and the
 * grade-trend logic (T8) is unit-testable headlessly. No React here — just the
 * stream + the persisted run list in, `DimensionRow[]` out.
 */
import type { ScorecardDimension, ScorecardGrade, ScorecardRun } from '@/lib/bridge';

import type { DimensionRow } from './DimensionGrid';
import { computeGradeTrend, gradeRankValue } from './scorecard.constants';
import type { ScorecardReadingView } from './scorecard.types';
import { type ScorecardStream, storedToReading } from './scorecard-stream';

/**
 * Per-dimension grades from every run OLDER than the displayed one, oldest-first —
 * the trend history each row compares its current grade against. "Older" keys on
 * `createdAt`, so a historical run selected from the menu trends against runs
 * before IT (not merely before the newest). A live/optimistic run isn't persisted
 * yet, so it isn't found in `runs` ⇒ treated as the newest (compares against all).
 */
export function priorGradesByDimension(
  runs: readonly ScorecardRun[],
  currentRunId: string | null,
): Map<ScorecardDimension, ScorecardGrade[]> {
  const current = currentRunId !== null ? runs.find((r) => r.id === currentRunId) : undefined;
  const currentCreatedAt = current?.createdAt ?? Number.MAX_SAFE_INTEGER;

  const map = new Map<ScorecardDimension, ScorecardGrade[]>();
  const older = runs
    .filter((r) => r.id !== currentRunId && r.createdAt < currentCreatedAt)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const run of older) {
    for (const stored of run.readings) {
      const reading = storedToReading(stored);
      const list = map.get(reading.dimension) ?? [];
      list.push(reading.grade);
      map.set(reading.dimension, list);
    }
  }
  return map;
}

/** Order rows for the results grid: graded rows worst-grade first, then ungraded
 *  (pending/running/errored) in dimension order. */
function sortRows(rows: DimensionRow[]): DimensionRow[] {
  return [...rows].sort((a, b) => {
    const ag = a.reading !== null ? 0 : 1;
    const bg = b.reading !== null ? 0 : 1;
    if (ag !== bg) return ag - bg;
    if (a.reading !== null && b.reading !== null) {
      return gradeRankValue(b.reading.grade) - gradeRankValue(a.reading.grade);
    }
    return 0;
  });
}

/**
 * Build the grid rows for the displayed run: one row per requested dimension, its
 * live pass state, the graded reading (if any), and its grade trend vs prior runs
 * (T8). Sorted worst-grade first.
 */
export function buildDimensionRows(
  stream: ScorecardStream,
  runs: readonly ScorecardRun[],
): DimensionRow[] {
  const byDim = new Map<string, ScorecardReadingView>();
  for (const r of stream.readings) byDim.set(r.dimension, r);
  const priorGrades = priorGradesByDimension(runs, stream.runId);

  const built: DimensionRow[] = stream.requestedDimensions.map((d) => {
    const reading = byDim.get(d) ?? null;
    return {
      dimension: d,
      state: stream.dimensionState[d] ?? 'pending',
      reading,
      trend:
        reading !== null ? computeGradeTrend(reading.grade, priorGrades.get(d) ?? []) : null,
    };
  });
  return sortRows(built);
}
