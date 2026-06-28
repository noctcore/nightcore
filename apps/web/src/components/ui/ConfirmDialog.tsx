/** Reusable confirmation modal for guarding destructive actions. */
import { type ReactNode } from 'react';
import { Button } from './Button';
import { Kbd } from './Kbd';
import { Modal } from './Modal';

/** Props for {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
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
  /** Called when the user confirms (Enter or the confirm button). */
  onConfirm: () => void;
  /** Called when the user cancels (Esc, click-outside, or Cancel). */
  onCancel: () => void;
}

/** A small centered confirmation modal — the reusable destructive-action guard.
 *  Cosmic-dark, matching the app's overlay chrome. Built on the shared `<Modal>`
 *  primitive, so it gets the focus trap + focus-restore-to-opener for free; Esc /
 *  click-outside cancel; Enter confirms; the confirm button takes initial focus. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      role="alertdialog"
      label={title}
      initialFocus="[data-confirm]"
      onClose={onCancel}
      onEnter={onConfirm}
    >
      <div className="flex flex-col gap-2 px-5 pb-4 pt-5">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <div className="text-[13px] leading-relaxed text-muted-foreground">{message}</div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>↵</Kbd> to confirm
        </span>
        <Button variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          data-confirm
          variant={destructive ? 'danger' : 'primary'}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
