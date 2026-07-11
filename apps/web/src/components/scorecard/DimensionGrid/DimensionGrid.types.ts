import type { ScorecardDimension } from '@/lib/bridge';

import type { GradeTrend } from '../scorecard.constants';
import type { ScorecardReadingView } from '../scorecard.types';
import type { DimensionProgress } from '../scorecard-stream';

/** One row in the grid: a dimension, its live pass state, and the graded reading
 *  once the pass completes (null while pending/running or if it errored). */
export interface DimensionRow {
  dimension: ScorecardDimension;
  /** Live pass state — drives the spinner vs the grade chip. */
  state: DimensionProgress;
  /** The graded reading for this dimension, when available. */
  reading: ScorecardReadingView | null;
  /** Grade trend vs the most recent older run that graded this dimension (T8);
   *  `null` when there's no prior run to compare against. */
  trend: GradeTrend | null;
}

/** Props for the DimensionGrid: the rows to render, an idle empty message, and an open handler. */
export interface DimensionGridProps {
  rows: DimensionRow[];
  /** Shown when there are no rows at all (idle). */
  emptyMessage: string;
  /** Open a dimension's reading in the detail panel (only fired for graded rows). */
  onOpen: (reading: ScorecardReadingView) => void;
}
