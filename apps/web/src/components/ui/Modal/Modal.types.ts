import type { ReactNode } from 'react';

import type { Variants } from '../motion';

/** Props for {@link Modal}. */
export interface ModalProps {
  /** Presence flag — Modal OWNS its enter/exit animation, so callers keep it
   *  always-mounted and toggle `open` (rather than `{cond && <Modal/>}`). When it
   *  flips false the panel + backdrop animate out before unmounting. */
  open: boolean;
  /** Accessible name for the dialog. */
  label: string;
  /** `dialog` (default) or `alertdialog` (destructive confirmations). */
  role?: 'dialog' | 'alertdialog';
  /** CSS selector for the element to focus on open. Defaults to the first
   *  focusable descendant. */
  initialFocus?: string;
  /** Classes for the centered overlay (positioning + backdrop). A sensible
   *  centered default is used when omitted. */
  overlayClassName?: string;
  /** Classes for the dialog panel (width, chrome). */
  panelClassName?: string;
  /** Motion variants for the panel's enter/exit. Defaults to `scaleFade` (centered
   *  dialogs); pass `slideIn` for an edge sheet. Must be transform + opacity only. */
  panelVariants?: Variants;
  /** Esc, click-outside, and the close affordance route here. */
  onClose: () => void;
  /** Optional Enter-to-confirm. When set, Enter anywhere in the dialog (outside a
   *  textarea) invokes it — matching the ConfirmDialog convention. */
  onEnter?: () => void;
  children: ReactNode;
}
