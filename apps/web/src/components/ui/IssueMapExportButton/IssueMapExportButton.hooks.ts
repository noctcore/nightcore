/** Open-state for the IssueMapExportButton. Kept here (not in the component body)
 *  so the trigger is a thin shell — and so the three results views that render it
 *  never take on any export state themselves. */
import { useCallback, useState } from 'react';

/** The trigger's tiny view model: whether the dialog is open + the open/close
 *  affordances. */
export interface IssueMapExportButtonView {
  open: boolean;
  openDialog: () => void;
  closeDialog: () => void;
}

/** Manage the export dialog's open flag. `openDialog` is inert without a run, so
 *  a disabled trigger can never surface an empty dialog. */
export function useIssueMapExportButton(runId: string | null): IssueMapExportButtonView {
  const [open, setOpen] = useState(false);
  const openDialog = useCallback(() => {
    if (runId !== null) setOpen(true);
  }, [runId]);
  const closeDialog = useCallback(() => setOpen(false), []);
  return { open, openDialog, closeDialog };
}
