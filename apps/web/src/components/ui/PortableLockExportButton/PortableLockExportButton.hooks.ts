/** State + the export action for the PortableLockExportButton. Kept here (not in the
 *  component body) so the trigger + dialog stay a thin shell and the Enforce results
 *  view never takes on any export state itself. */
import { useCallback, useState } from 'react';

import { exportPortableLock, type PortableLockExport } from '@/lib/bridge';

/** The trigger + dialog's view model: dialog open-state, the run action + its result/
 *  error/loading, and the workflow copy affordance. */
export interface PortableLockExportButtonView {
  open: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  /** True while `export_portable_lock` is in flight. */
  running: boolean;
  /** The staged bundle descriptor once the export completes; `null` before then. */
  result: PortableLockExport | null;
  /** A human-readable failure (or the browser-preview unavailable note); `null` on
   *  the happy path. */
  error: string | null;
  /** Stage the bundle (idempotent — re-runs overwrite only the staging dir). */
  runExport: () => void;
  /** True once the workflow YAML has been copied to the clipboard. */
  copied: boolean;
  copyWorkflow: () => void;
}

/** Own the export dialog: its open flag, the one write action, and the workflow copy.
 *  `openDialog` is inert without a project, so a disabled trigger never surfaces an
 *  empty dialog; closing resets the transient result/error/copied so re-opening starts
 *  on the preview. */
export function usePortableLockExportButton(
  projectPath: string | null,
): PortableLockExportButtonView {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PortableLockExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const openDialog = useCallback(() => {
    if (projectPath !== null) setOpen(true);
  }, [projectPath]);

  const closeDialog = useCallback(() => {
    setOpen(false);
    setResult(null);
    setError(null);
    setCopied(false);
    setRunning(false);
  }, []);

  const runExport = useCallback(() => {
    if (projectPath === null || running) return;
    setRunning(true);
    setError(null);
    void exportPortableLock(projectPath)
      .then((res) => {
        if (res === null) {
          setError('Exporting the portable lock is unavailable in the browser preview.');
        } else {
          setResult(res);
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRunning(false));
  }, [projectPath, running]);

  const copyWorkflow = useCallback(() => {
    if (result === null) return;
    void navigator.clipboard.writeText(result.workflowYaml).then(() => setCopied(true));
  }, [result]);

  return {
    open,
    openDialog,
    closeDialog,
    running,
    result,
    error,
    runExport,
    copied,
    copyWorkflow,
  };
}
