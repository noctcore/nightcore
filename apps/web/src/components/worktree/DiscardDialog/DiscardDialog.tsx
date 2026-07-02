import { AlertIcon, Button, Modal, Spinner } from '@/components/ui';

import {
  discardConfirmLabel,
  hasDiscardError,
  hasUncommittedChanges,
} from './DiscardDialog.hooks';
import type { DiscardDialogProps } from './DiscardDialog.types';

/** A destructive confirmation modal for discarding a worktree and deleting its
 *  branch. Built on the shared `<Modal>` primitive as an `alertdialog`, so it gets
 *  the focus trap + focus-restore for free; Esc / click-outside / Cancel dismiss.
 *
 *  Purely presentational: the parent owns the discard call and `discarding`/`error`
 *  state, and closes the dialog on success. The confirm button calls `onConfirm`
 *  directly — it never auto-closes. Cancel takes initial focus (a deliberate guard
 *  for an irreversible delete). */
export function DiscardDialog({
  open,
  branch,
  changedFiles,
  discarding = false,
  error,
  onConfirm,
  onClose,
}: DiscardDialogProps) {
  if (!open) return null;

  return (
    <Modal
      role="alertdialog"
      label="Discard worktree"
      initialFocus="[data-cancel]"
      onClose={onClose}
    >
      <div className="flex flex-col gap-2.5 px-5 pb-4 pt-5">
        <h2 className="text-base font-semibold text-foreground">Discard worktree</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          This permanently removes the worktree for{' '}
          <span className="font-medium text-foreground">{branch ?? 'this task'}</span> and deletes
          its branch. Uncommitted changes are lost.
        </p>
        {hasUncommittedChanges(changedFiles) && (
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-warning">
            <AlertIcon size={13} className="shrink-0" />
            {changedFiles} uncommitted file(s) will be lost.
          </p>
        )}
        {hasDiscardError(error) && (
          <p className="rounded-[8px] border border-destructive/40 bg-destructive/[0.12] px-3 py-2 text-[12px] text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        <Button data-cancel variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={discarding} onClick={onConfirm}>
          {discarding ? (
            <>
              <Spinner />
              <span>Discarding…</span>
            </>
          ) : (
            discardConfirmLabel(error)
          )}
        </Button>
      </div>
    </Modal>
  );
}
