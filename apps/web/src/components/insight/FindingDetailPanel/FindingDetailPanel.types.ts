/** Props for the FindingDetailPanel sheet. */
import type { InsightFinding } from '../insight.types';

/** Props for the FindingDetailPanel: the finding to show plus its lifecycle
 *  action handlers, all owned upstream by the InsightView hook. */
export interface FindingDetailPanelProps {
  /** Presence flag — the sheet slides in/out. Keep it always-mounted and toggle
   *  `open` instead of `{selected && <FindingDetailPanel/>}`. */
  open: boolean;
  /** The finding rendered in the sheet (null while nothing is selected). */
  finding: InsightFinding | null;
  /** True while a finding action (convert/dismiss/restore) is in flight. */
  pending: boolean;
  /** Close the sheet. */
  onClose: () => void;
  /** Convert the finding into a task. */
  onConvert: (findingId: string) => void;
  /** Dismiss the finding. */
  onDismiss: (findingId: string) => void;
  /** Restore a previously dismissed finding. */
  onRestore: (findingId: string) => void;
  /** Navigate to the linked task on the board (for a converted finding). */
  onGotoBoard?: () => void;
}
