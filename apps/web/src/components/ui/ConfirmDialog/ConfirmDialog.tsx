/** Reusable confirmation modal for guarding destructive actions. */
import { Button } from '../Button';
import { Kbd } from '../Kbd';
import { Modal, useLastPresent } from '../Modal';
import { Spinner } from '../Spinner';
import type { ConfirmDialogProps } from './ConfirmDialog.types';

/** A small centered confirmation modal — the reusable destructive-action guard.
 *  Cosmic-dark, matching the app's overlay chrome. Built on the shared `<Modal>`
 *  primitive, so it gets the focus trap + focus-restore-to-opener for free; Esc /
 *  click-outside cancel; Enter confirms; the confirm button takes initial focus. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Retain the display content across the exit animation so the panel doesn't
  // blank when the parent clears its confirmation state on close. Callbacks stay
  // live (the parent's current handlers); only the rendered content is retained.
  const shown =
    useLastPresent(
      open ? { title, message, confirmLabel, cancelLabel, destructive, busy } : null,
    ) ?? { title, message, confirmLabel, cancelLabel, destructive, busy };

  return (
    <Modal
      open={open}
      role="alertdialog"
      label={shown.title}
      initialFocus="[data-confirm]"
      onClose={onCancel}
      // Enter is inert while the action is in flight so a held key can't re-fire it.
      onEnter={shown.busy ? undefined : onConfirm}
    >
      <div className="flex flex-col gap-2 px-5 pb-4 pt-5">
        <h2 className="text-base font-semibold text-foreground">{shown.title}</h2>
        <div className="text-[13px] leading-relaxed text-muted-foreground">{shown.message}</div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>↵</Kbd> to confirm
        </span>
        <Button variant="ghost" disabled={shown.busy} onClick={onCancel}>
          {shown.cancelLabel}
        </Button>
        <Button
          data-confirm
          variant={shown.destructive ? 'danger' : 'primary'}
          disabled={shown.busy}
          aria-busy={shown.busy}
          onClick={onConfirm}
        >
          {shown.busy ? <Spinner size={14} /> : null}
          {shown.confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
