/** Shared focus-trapped modal dialog primitive. */
import { createPortal } from 'react-dom';

import { AnimatePresence, backdrop, m, scaleFade } from '../motion';
import { isConfirmEnter, useModal } from './Modal.hooks';
import type { ModalProps } from './Modal.types';

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
 *  Esc and click-outside close; Cmd/Ctrl+Enter (when `onEnter` is set) confirms —
 *  bare Enter never does (the house dialog rule), and Enter inside a textarea
 *  always inserts a newline. Click-outside is suppressed when the click originates
 *  inside the panel.
 *
 *  The overlay is portaled to `document.body` so ancestor flex/transform/stacking
 *  rules (e.g. `.nc-board-appearance`) never participate in its layout. */
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

  const overlay = (
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
              if (onEnter !== undefined && isConfirmEnter(e)) {
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

  if (typeof document === 'undefined') {
    return overlay;
  }

  return createPortal(overlay, document.body);
}
