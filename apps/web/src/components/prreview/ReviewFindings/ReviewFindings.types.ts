/** Props for the ReviewFindings results grid. */
import type { ReviewFindingView } from '../prreview.types';

/** Props for the ReviewFindings grid: the findings to render (grouped by severity),
 *  the streaming skeletons, the empty message, and the selection + open handlers. */
export interface ReviewFindingsProps {
  /** The findings to render as cards, grouped into severity sections. */
  findings: ReviewFindingView[];
  /** Number of skeleton placeholder cards to show while a lens is still streaming. */
  skeletonCount: number;
  /** Shown when there are no findings and nothing is streaming. */
  emptyMessage: string;
  /** The set of finding ids selected for the posted review. */
  selection: ReadonlySet<string>;
  /** Toggle a finding in/out of the selection. */
  onToggleSelect: (findingId: string) => void;
  /** Open a finding's detail panel. */
  onOpen: (finding: ReviewFindingView) => void;
}
