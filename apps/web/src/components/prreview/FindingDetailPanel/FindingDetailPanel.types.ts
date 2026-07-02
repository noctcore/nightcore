/** Props for the PR Review FindingDetailPanel sheet. */
import type { ReviewFindingView } from '../prreview.types';

/** Props for the FindingDetailPanel: the review finding to show plus its lifecycle
 *  action handlers, all owned upstream by the PrReviewView hook. */
export interface FindingDetailPanelProps {
  /** The finding rendered in the sheet. */
  finding: ReviewFindingView;
  /** True while a finding action (convert/dismiss/restore) is in flight. */
  pending: boolean;
  /** Close the sheet. */
  onClose: () => void;
  /** Convert the finding into a board task. */
  onConvert: (findingId: string) => void;
  /** Dismiss the finding. */
  onDismiss: (findingId: string) => void;
  /** Restore a previously dismissed finding. */
  onRestore: (findingId: string) => void;
  /** Navigate to the linked task on the board (for a converted finding). */
  onGotoBoard?: () => void;
}
