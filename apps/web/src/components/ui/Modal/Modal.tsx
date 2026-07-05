/** Shared focus-trapped modal dialog primitive. */
import type { ReactNode } from 'react';

import { AnimatePresence, backdrop, m, scaleFade, type Variants } from '../motion';
import { useModal } from './Modal.hooks';

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

const DEFAULT_OVERLAY =
  'fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm';
const DEFAULT_PANEL =
  'w-full max-w-sm overflow-hidden rounded-[14px] border border-border bg-popover shadow-2xl';

/** The shared modal primitive (a11y): an inert-background overlay over a focus-
 *  trapped dialog panel, with a Tab/Shift+Tab focus trap and focus restore to the
 *  opener on close.
 *
 *  Presence is owned here (`open`): an `AnimatePresence` fades the backdrop and
 *  scale/slides the panel on BOTH mount and unmount, so dialogs no longer hard-cut
 *  when closed. `MotionConfig reducedMotion="user"` (app root) collapses the
 *  transforms under OS reduced-motion, keeping only the opacity fade.
 *
 *  Esc and click-outside close; Enter (when `onEnter` is set) confirms, except
 *  inside a textarea where Enter inserts a newline. Click-outside is suppressed
 *  when the click originates inside the panel. */
export function Modal({
  open,
  label,
  role = 'dialog',
  initialFocus,
  overlayClassName = DEFAULT_OVERLAY,
  panelClassName = DEFAULT_PANEL,
  panelVariants = scaleFade,
  onClose,
  onEnter,
  children,
}: ModalProps) {
  const ref = useModal<HTMLDivElement>(onClose, initialFocus, open);

  return (
    <AnimatePresence>
      {open && (
        <m.div
          role="presentation"
          className={overlayClassName}
          onClick={onClose}
          variants={backdrop}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <m.div
            ref={ref}
            role={role}
            aria-modal="true"
            aria-label={label}
            className={panelClassName}
            variants={panelVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (
                onEnter !== undefined &&
                e.key === 'Enter' &&
                !(e.target instanceof HTMLTextAreaElement)
              ) {
                e.preventDefault();
                onEnter();
              }
            }}
          >
            {children}
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
