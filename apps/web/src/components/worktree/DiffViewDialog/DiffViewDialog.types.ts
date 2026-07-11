/** Props for the DiffViewDialog component. */
import type { WorktreeDiff } from '@/lib/bridge';

/** Props for the changed-files dialog: a presentational modal listing the files
 *  changed in a worktree vs its base. All data + the close handler arrive via
 *  props — the parent owns the bridge call that produces `diff`. */
export interface DiffViewDialogProps {
  /** Whether the dialog is mounted. When false, nothing renders. */
  open: boolean;
  /** The computed worktree diff, or `null` while it has not been loaded yet. */
  diff: WorktreeDiff | null;
  /** The task whose worktree the diff belongs to, threaded so an expanded file
   *  row can lazily fetch its per-file patch (`worktree_file_diff`). `null` when
   *  no diff is open — the per-file fetch stays idle. */
  taskId: string | null;
  /** Show the loading spinner while the diff is being computed. */
  loading?: boolean;
  /** Esc, click-outside, and the close affordance route here. */
  onClose: () => void;
  /** Heading shown at the top of the dialog. Defaults to `Changed files`. */
  title?: string;
}
