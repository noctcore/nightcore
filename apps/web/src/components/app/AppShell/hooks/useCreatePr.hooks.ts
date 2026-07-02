import { useCallback, useState } from 'react';

import type { ToastApi } from '@/components/ui';
import { type CreatePrOptions, createPrTask, listTasks, openExternal } from '@/lib/bridge';

import type { ActionGuard } from './useActionGuard.hooks';

/** The Create PR controller: the dialog's open state (keyed by task id), the
 *  guarded create mutation, and the PR-chip link-out. */
export interface CreatePrController {
  /** The task id the Create PR dialog is open for (`null` = closed). */
  prDialogTaskId: string | null;
  /** Open the Create PR dialog for a task (the drawer's Create PR button). */
  openPrDialog: (id: string) => void;
  /** Close the Create PR dialog. */
  closePrDialog: () => void;
  /** Push the branch + `gh pr create`, guarded like merge/commit. Resolves on
   *  success (after the success toast); REJECTS on failure so the dialog can
   *  show the error inline and stay open — the deliberate NewTaskForm-style
   *  rethrow. A failure ALSO fires an error toast, so it still surfaces when
   *  the dialog was dismissed mid-submit and nobody hears the rejection. */
  create: (id: string, opts: CreatePrOptions) => Promise<void>;
  /** Open a created PR in the system browser (backend https-only validated). */
  openPr: (url: string) => void;
}

/** Dialog state + the guarded `create_pr_task` mutation. Cloned from the
 *  `handleMerge` action-guard shape so `isActionPending('createPr', id)` works,
 *  but returning a promise so the dialog (the human gate) owns the error UX.
 *  The success toast carries the PR number, re-read from the store — the
 *  command returns void and the `nc:task` echo may not have landed yet. */
export function useCreatePr(action: ActionGuard, toast: ToastApi): CreatePrController {
  const [prDialogTaskId, setPrDialogTaskId] = useState<string | null>(null);

  const openPrDialog = useCallback((id: string) => setPrDialogTaskId(id), []);
  const closePrDialog = useCallback(() => setPrDialogTaskId(null), []);

  const create = useCallback(
    (id: string, opts: CreatePrOptions): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        // `guard` runs the closure synchronously unless this task's create is
        // already in flight, so `leased` reliably tells the two paths apart.
        let leased = false;
        action.guard('createPr', id, () => {
          leased = true;
          return createPrTask(id, opts).then(
            async () => {
              const prNumber = await listTasks()
                .then((tasks) => tasks.find((t) => t.id === id)?.prNumber)
                .catch(() => undefined);
              toast.push({
                tone: 'success',
                title:
                  prNumber !== undefined
                    ? `Pull request #${prNumber} created`
                    : 'Pull request created',
              });
              resolve();
            },
            (err: unknown) => {
              console.error('create_pr_task failed', err);
              // Toast BESIDES rejecting (the sibling failure-toast pattern):
              // the dialog may have been dismissed mid-submit, and a rejection
              // with no listener would leave the failure invisible.
              toast.error('Could not create the pull request', err);
              reject(err instanceof Error ? err : new Error(String(err)));
            },
          );
        });
        // The guard no-oped (already in flight): settle the promise so the
        // caller is never left hanging. The dialog single-flights its own
        // submit, so this path is a defensive backstop, not a UX surface.
        if (!leased) reject(new Error('A pull request is already being created for this task.'));
      }),
    [action, toast],
  );

  const openPr = useCallback(
    (url: string) => {
      void openExternal(url).catch((err) => {
        console.error('open_external failed', err);
        toast.error('Could not open the pull request', err);
      });
    },
    [toast],
  );

  return { prDialogTaskId, openPrDialog, closePrDialog, create, openPr };
}
