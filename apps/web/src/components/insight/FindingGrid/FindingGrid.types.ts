import type { InsightFinding } from '../insight.types';

export interface FindingGridProps {
  findings: InsightFinding[];
  /** Number of skeleton placeholder cards to show below real ones (categories
   *  still streaming in the active view). */
  skeletonCount: number;
  /** Shown when there are no findings and nothing is streaming. */
  emptyMessage: string;
  onOpen: (finding: InsightFinding) => void;
}
