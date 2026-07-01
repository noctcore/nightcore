/** Types for the ProposalDetailPanel sheet. */
import type { HarnessProposalVM } from '../harness.types';

/** Props for {@link ProposalDetailPanel}: the proposal to show, a `pending` flag that
 *  disables the lifecycle actions, and the close/convert/dismiss/restore handlers. */
export interface ProposalDetailPanelProps {
  proposal: HarnessProposalVM;
  pending: boolean;
  onClose: () => void;
  /** Convert the proposal into a board task. */
  onConvert: (proposalId: string) => void;
  onDismiss: (proposalId: string) => void;
  onRestore: (proposalId: string) => void;
  /** Navigate to the linked task on the board (for a converted proposal). */
  onGotoBoard?: () => void;
}
