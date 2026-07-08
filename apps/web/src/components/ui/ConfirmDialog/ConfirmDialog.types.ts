import type { ReactNode } from 'react';

/** Props for {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  /** Presence flag — the dialog animates in/out. Keep it always-mounted and toggle
   *  `open` instead of `{cond && <ConfirmDialog/>}`. */
  open: boolean;
  /** Heading shown at the top of the dialog. */
  title: string;
  /** Body — a short sentence (string) or richer content (node). */
  message: ReactNode;
  /** Confirm button label. Defaults to `Confirm`. */
  confirmLabel?: string;
  /** Cancel button label. Defaults to `Cancel`. */
  cancelLabel?: string;
  /** Render the confirm action as destructive (red). */
  destructive?: boolean;
  /** While the confirmed action is in flight: the confirm shows a spinner and is
   *  disabled + `aria-busy` (so it can't double-fire), Cancel is disabled, and
   *  Enter is inert (a held key can't re-trigger). Defaults to `false`. */
  busy?: boolean;
  /** Called when the user confirms (Enter or the confirm button). */
  onConfirm: () => void;
  /** Called when the user cancels (Esc, click-outside, or Cancel). */
  onCancel: () => void;
}
