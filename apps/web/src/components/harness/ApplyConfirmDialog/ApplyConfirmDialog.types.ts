/** Props for the ApplyConfirmDialog pre-write confirmation modal. */
import type { ProposedArtifactVM } from '../harness.types';

export interface ApplyConfirmDialogProps {
  /** Presence flag — the dialog animates in/out. Keep it always-mounted and toggle
   *  `open` instead of `{cond && <ApplyConfirmDialog/>}`. */
  open: boolean;
  /** The artifact the user is about to write to disk (or `null` while closed —
   *  the last one is retained across the exit animation). */
  artifact: ProposedArtifactVM | null;
  /** True while the apply write is in flight — disables confirm. */
  applying: boolean;
  /** The error returned by `apply_harness_artifact`, surfaced inline (or null). */
  error: string | null;
  /** Confirm the write (Enter or the Apply button). */
  onConfirm: () => void;
  /** Cancel (Esc, click-outside, or Cancel). */
  onCancel: () => void;
}
