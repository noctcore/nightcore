/** Types for the ConventionDetailPanel sheet. */
import type { ConventionFindingVM } from '../harness.types';

/** Props for {@link ConventionDetailPanel}: the finding to show, a `pending` flag
 *  that disables the lifecycle actions, and the close/convert/dismiss/restore handlers. */
export interface ConventionDetailPanelProps {
  /** Presence flag — the sheet slides in/out. Keep it always-mounted and toggle
   *  `open` instead of `{selected && <ConventionDetailPanel/>}`. */
  open: boolean;
  finding: ConventionFindingVM | null;
  pending: boolean;
  onClose: () => void;
  /** Convert the finding into a board task. */
  onConvert: (findingId: string) => void;
  onDismiss: (findingId: string) => void;
  onRestore: (findingId: string) => void;
  /** Navigate to the linked task on the board (for a converted finding). */
  onGotoBoard?: () => void;
}
