/** Props for the MergePreviewDialog component. */
import type { MergePreview } from '@/lib/bridge';

/** Props for the merge-preview modal: the computed preview plus the in-flight
 *  flags and the merge/close/diff handlers. Purely presentational — the parent
 *  computes the preview (via the bridge) and owns the merge action. */
export interface MergePreviewDialogProps {
  /** Whether the dialog is mounted/visible. */
  open: boolean;
  /** The computed merge preview, or `null` while it is still being fetched. */
  preview: MergePreview | null;
  /** The preview is still being computed (conflict check in flight). */
  loading?: boolean;
  /** A merge is currently in flight. */
  merging?: boolean;
  /** Count of live user terminal sessions open in this worktree (terminal spec,
   *  decision 2). When greater than zero, a blocking notice warns that merging
   *  will close them first; the parent's merge handler kills them then merges. */
  terminalSessions?: number;
  /** Fired when the user confirms the merge. */
  onMerge: () => void;
  /** Fired on Esc, click-outside, the close affordance, or Cancel. */
  onClose: () => void;
  /** Optional "View full diff" affordance. */
  onViewDiff?: () => void;
}
