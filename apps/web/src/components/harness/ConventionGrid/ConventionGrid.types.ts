/** Types for the ConventionGrid. */
import type { ConventionFindingVM } from '../harness.types';

/** Props for {@link ConventionGrid}: the findings to render, the streaming
 *  skeleton count, the empty-state message, and the open-finding callback. */
export interface ConventionGridProps {
  findings: ConventionFindingVM[];
  /** Number of skeleton placeholder cards to show below real ones (lenses still
   *  streaming in the active view). */
  skeletonCount: number;
  /** Shown when there are no findings and nothing is streaming. */
  emptyMessage: string;
  onOpen: (finding: ConventionFindingVM) => void;
}
