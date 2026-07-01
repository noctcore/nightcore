/** Types for the ConventionDetailPanel sheet. */
import type { ConventionFindingVM } from '../harness.types';

/** Props for {@link ConventionDetailPanel}: the finding to show, a `pending` flag
 *  that disables the lifecycle actions, and the close/convert/dismiss/restore handlers. */
export interface ConventionDetailPanelProps {
  finding: ConventionFindingVM;
  pending: boolean;
  onClose: () => void;
  /** Convert the finding into a board task. */
  onConvert: (findingId: string) => void;
  onDismiss: (findingId: string) => void;
  onRestore: (findingId: string) => void;
  /** Navigate to the linked task on the board (for a converted finding). */
  onGotoBoard?: () => void;
}
