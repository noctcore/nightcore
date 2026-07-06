import { useCallback, useMemo } from 'react';

import type { ToastApi } from '@/components/ui';
import { discardWorktree } from '@/lib/bridge';
import type { RemovableWorktreeTab, WorktreesContextValue } from '@/lib/worktrees-context';

import { useWorktrees } from './useWorktrees.hooks';

/** Assemble the shared worktrees context value, owning `useWorktrees` internally.
 *  Extracted from `useAppShell` so the shell composition hook stays thin; the memoized
 *  result is provided to the board switcher, the board's worktree filter, and the
 *  standalone WorktreeView via `WorktreesProvider`. It re-identifies only when the
 *  worktree list refetches (debounced `nc:task`), the selection changes, or a handler
 *  re-identifies — never on a per-frame `nc:session` flush.
 *
 *  `reseed` (the board's task re-pull) is passed in so the explicit Refresh can
 *  reconcile worktrees server-side AND re-pull tasks in one action. */
export function useWorktreesValue(
  reseed: () => void,
  toast: ToastApi,
): WorktreesContextValue {
  const worktrees = useWorktrees();

  // Remove a worktree straight from its switcher tab: discard the checkout + branch
  // for every task the tab groups (v1 is one-per-branch). The backend refuses a
  // running task and clears `task.branch` on success, so the `nc:task` echo drops
  // the tab; we only need to bounce the selection off a tab that's about to vanish.
  const handleRemoveWorktree = useCallback(
    (tab: RemovableWorktreeTab) => {
      if (tab.branch === null) return; // the Main tab is not removable
      if (tab.taskIds.length === 0) {
        toast.error('Could not remove worktree', 'No task is linked to this worktree.');
        return;
      }
      if (worktrees.active === tab.branch) worktrees.setActive(null);
      void Promise.allSettled(tab.taskIds.map((id) => discardWorktree(id))).then((results) => {
        const failed = results.find((r) => r.status === 'rejected');
        if (failed !== undefined) {
          const err = (failed as PromiseRejectedResult).reason;
          console.error('discard_worktree failed', err);
          toast.error('Could not remove worktree', err);
          return;
        }
        toast.push({ tone: 'success', title: 'Worktree removed' });
      });
    },
    // `active` is a value (re-identify when it changes); `setActive` is a stable
    // setter — so this handler stays stable except on a tab-selection change.
    [worktrees.active, worktrees.setActive, toast],
  );

  // The explicit board/Worktrees "Refresh": reconcile worktrees server-side AND
  // re-pull tasks, so any stale state (a merged/removed worktree's ghost tab)
  // resolves without an app restart. Depends only on the stable callbacks so it
  // doesn't re-identify each render and defeat `memo(Board)`.
  const handleRefreshWorktrees = useCallback(() => {
    reseed();
    void worktrees.reconcile().then(
      () => toast.push({ tone: 'success', title: 'Worktrees refreshed' }),
      (err) => {
        console.error('refresh_worktrees failed', err);
        toast.error('Could not refresh worktrees', err);
      },
    );
  }, [reseed, worktrees.reconcile, toast]);

  return useMemo<WorktreesContextValue>(
    () => ({
      worktrees: worktrees.worktrees,
      activeWorktree: worktrees.active,
      setActiveWorktree: worktrees.setActive,
      removeWorktree: handleRemoveWorktree,
      refreshWorktrees: handleRefreshWorktrees,
    }),
    [
      worktrees.worktrees,
      worktrees.active,
      worktrees.setActive,
      handleRemoveWorktree,
      handleRefreshWorktrees,
    ],
  );
}
