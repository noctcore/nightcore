/** Props for the DiscardDialog component. */

/** Props for the destructive worktree-discard confirmation modal. Presentational:
 *  the parent owns the discard call, tracks `discarding`/`error`, and closes the
 *  dialog on success. */
export interface DiscardDialogProps {
  /** Whether the dialog is mounted. Renders nothing when false. */
  open: boolean;
  /** The branch being discarded — woven into the consequence copy. Falls back to
   *  "this task" when omitted. */
  branch?: string;
  /** Count of uncommitted files that would be lost. Drives the amber warning line
   *  when greater than zero. */
  changedFiles?: number;
  /** Whether a discard is in flight — swaps the confirm button for a spinner. */
  discarding?: boolean;
  /** The last discard error, if any. When set, it is shown (red) and the confirm
   *  button flips to "Retry". */
  error?: string | null;
  /** Fired when the user confirms the discard (the confirm button). Does NOT close
   *  the dialog — the parent closes it on success. */
  onConfirm: () => void;
  /** Fired when the user dismisses (Cancel, Esc, or click-outside). */
  onClose: () => void;
}
