/** Types for the ConventionDetailPanel sheet. */
import type { ConventionFindingVM } from '../harness.types';

/** Props for {@link ConventionDetailPanel}: the finding to show, a `pending` flag
 *  that disables the lifecycle actions, and the close/dismiss/restore handlers. */
export interface ConventionDetailPanelProps {
  finding: ConventionFindingVM;
  pending: boolean;
  onClose: () => void;
  onDismiss: (findingId: string) => void;
  onRestore: (findingId: string) => void;
}
