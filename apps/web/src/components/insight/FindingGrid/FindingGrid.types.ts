/** Props for the FindingGrid component. */
import type { InsightFinding } from '../insight.types';

/** Props for the FindingGrid: findings to render, streaming skeletons, and the
 *  empty-state message + open handler. */
export interface FindingGridProps {
  /** The findings to render as cards. */
  findings: InsightFinding[];
  /** Number of skeleton placeholder cards to show below real ones (categories
   *  still streaming in the active view). */
  skeletonCount: number;
  /** Shown when there are no findings and nothing is streaming. */
  emptyMessage: string;
  /** Open a finding's detail panel. */
  onOpen: (finding: InsightFinding) => void;
}
