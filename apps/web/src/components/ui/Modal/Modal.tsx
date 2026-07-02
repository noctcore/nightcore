/** Shared focus-trapped modal dialog primitive. */
import type { ReactNode } from 'react';

import { useModal } from './Modal.hooks';

/** Props for {@link Modal}. */
export interface ModalProps {
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
  /** Inline style for the dialog panel (typically the entrance animation). */
  panelStyle?: React.CSSProperties;
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
const DEFAULT_ANIM: React.CSSProperties = {
  animation: 'nc-rise .22s cubic-bezier(.22,1,.36,1)',
};

/** The shared modal primitive (a11y): an inert-background overlay over a focus-
 *  trapped dialog panel, with a Tab/Shift+Tab focus trap and focus restore to the
 *  opener on close.
 *
 *  Esc and click-outside close; Enter (when `onEnter` is set) confirms, except
 *  inside a textarea where Enter inserts a newline. Click-outside is suppressed
 *  when the click originates inside the panel. */
export function Modal({
  label,
  role = 'dialog',
  initialFocus,
  overlayClassName = DEFAULT_OVERLAY,
  panelClassName = DEFAULT_PANEL,
  panelStyle = DEFAULT_ANIM,
  onClose,
  onEnter,
  children,
}: ModalProps) {
  const ref = useModal<HTMLDivElement>(onClose, initialFocus);

  return (
    <div role="presentation" className={overlayClassName} onClick={onClose}>
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-label={label}
        className={panelClassName}
        style={panelStyle}
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
      </div>
    </div>
  );
}
