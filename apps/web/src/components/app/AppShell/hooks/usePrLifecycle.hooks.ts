import { useCallback, useMemo } from 'react';

import type { ToastApi } from '@/components/ui';
import { finalizeMergedPr, pullBaseFf, pushPrUpdates } from '@/lib/bridge';

import type { ActionGuard } from './useActionGuard.hooks';

/** The guarded PR-lifecycle mutations behind the PrStatusCard's human gates:
 *  push-updates, remote-merged finalize, and the base fast-forward. */
export interface PrLifecycleController {
  /** Re-push the task branch (plain push, never `--force`). Resolves on success
   *  so the card can refetch the PR status; REJECTS on failure. A failure ALSO
   *  fires an error toast (the useCreatePr discipline) so it surfaces even when
   *  the caller's rejection handler is a swallow. Pending key: `pushPrUpdates`. */
  pushUpdates: (id: string) => Promise<void>;
  /** Finalize a REMOTE-merged PR: mark the task merged locally + honor the
   *  cleanup setting. The `nc:task` echo updates the board — the caller does no
   *  state juggling. Pending key: `finalizePr`. */
  finalize: (id: string) => Promise<void>;
  /** Fast-forward-only pull of the base branch on the project root. The backend
   *  refusal (dirty root / non-ff) surfaces verbatim in the failure toast.
   *  Pending key: `pullBaseFf`. */
  pullBase: (id: string) => Promise<void>;
}

/** The three guarded PR-lifecycle mutations, cloned from the `useCreatePr`
 *  action-guard shape so `isActionPending('<key>', id)` disables the matching
 *  card button. Each returns a promise (success ⇒ toast + resolve; failure ⇒
 *  toast + reject) because the card sequences a refetch after a push. */
export function usePrLifecycle(action: ActionGuard, toast: ToastApi): PrLifecycleController {
  // One factory keeps the three mutations byte-identical: guard by pending key,
  // success toast + resolve, failure console + toast + reject. The not-leased
  // reject is a defensive backstop (the card disables its buttons via
  // `isActionPending`), mirroring useCreatePr.
  const guarded = useCallback(
    (
      key: string,
      run: (id: string) => Promise<void>,
      successTitle: string,
      failureTitle: string,
    ) =>
      (id: string): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          let leased = false;
          action.guard(key, id, () => {
            leased = true;
            return run(id).then(
              () => {
                toast.push({ tone: 'success', title: successTitle });
                resolve();
              },
              (err: unknown) => {
                console.error(`${key} failed`, err);
                // Toast BESIDES rejecting: the card swallows the rejection (the
                // failure UX is this toast), so it must never stay invisible.
                toast.error(failureTitle, err);
                reject(err instanceof Error ? err : new Error(String(err)));
              },
            );
          });
          if (!leased) reject(new Error('This PR action is already in flight for the task.'));
        }),
    [action, toast],
  );

  const pushUpdates = useMemo(
    () =>
      guarded(
        'pushPrUpdates',
        pushPrUpdates,
        'Updates pushed to the pull request',
        'Could not push the updates',
      ),
    [guarded],
  );
  const finalize = useMemo(
    () =>
      guarded(
        'finalizePr',
        finalizeMergedPr,
        'Task marked merged',
        'Could not finalize the pull request',
      ),
    [guarded],
  );
  const pullBase = useMemo(
    () =>
      guarded('pullBaseFf', pullBaseFf, 'Base branch updated', 'Could not update the base branch'),
    [guarded],
  );

  return useMemo(
    () => ({ pushUpdates, finalize, pullBase }),
    [pushUpdates, finalize, pullBase],
  );
}
