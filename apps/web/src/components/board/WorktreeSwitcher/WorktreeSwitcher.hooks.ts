/** WorktreeSwitcher derivation: per-worktree task filtering and tab building. */
import { useMemo } from 'react';

import type { Task, WorktreeInfo } from '@/lib/bridge';

import type { ActiveWorktree, WorktreeTab } from './WorktreeSwitcher.types';

/** Whether a task is actively running (counts toward a tab's running indicator). */
function isRunning(task: Task): boolean {
  return task.status === 'in_progress' || task.status === 'verifying';
}

/** Filter the board to the active worktree. The Main tab shows `run_mode === 'main'`
 *  tasks PLUS any branchless task (`branch === null`) — a worktree-mode task lives on
 *  the main board until the coordinator names its branch at submit, otherwise it would
 *  be unreachable from every tab. A worktree tab shows tasks whose branch matches.
 *  Exported so the board's view hook and the switcher derive identical sets. */
export function filterTasksByWorktree(tasks: Task[], active: ActiveWorktree): Task[] {
  if (active === null)
    return tasks.filter((task) => task.runMode === 'main' || task.branch === null);
  return tasks.filter((task) => task.branch === active);
}

/** The distinct branches a task set references — folded into the tab source so a task
 *  whose branch has no live worktree directory (yet, or anymore) still gets a tab.
 *  Only branchful tasks contribute; branchless ones belong on the Main tab. */
function branchesFromTasks(tasks: Task[]): string[] {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.branch !== null) seen.add(task.branch);
  }
  return [...seen];
}

/** Zeroed monitor fields for a task branch with no live worktree directory. */
function synthWorktree(branch: string): WorktreeInfo {
  return {
    branch,
    path: '',
    taskIds: [],
    dirty: false,
    aheadOfBase: 0,
    behindOfBase: 0,
    changedFiles: 0,
  };
}

/** Build the switcher's tabs: a Main tab plus one per branch, sourced from the UNION
 *  of live worktrees and distinct task branches (deduped by branch). A live worktree
 *  with no tasks still gets a tab; a task branch with no live worktree directory (yet,
 *  or anymore) also gets one, with zeroed monitor fields. Each tab carries its
 *  task/running counts and — for worktree tabs — the dirty/ahead monitor state. */
export function useWorktreeTabs(tasks: Task[], worktrees: WorktreeInfo[]): WorktreeTab[] {
  return useMemo(() => {
    const mainTasks = filterTasksByWorktree(tasks, null);
    const mainTab: WorktreeTab = {
      branch: null,
      label: 'Main',
      taskIds: [],
      taskCount: mainTasks.length,
      runningCount: mainTasks.filter(isRunning).length,
      dirty: false,
      aheadOfBase: 0,
      behindOfBase: 0,
      changedFiles: 0,
    };

    // Union: live worktrees first (they carry real monitor state), then any task
    // branch without a live directory, synthesized with zeroed fields. Deduped by
    // branch so a task on a live worktree's branch doesn't spawn a second tab.
    const byBranch = new Map<string, WorktreeInfo>();
    for (const worktree of worktrees) byBranch.set(worktree.branch, worktree);
    for (const branch of branchesFromTasks(tasks))
      if (!byBranch.has(branch)) byBranch.set(branch, synthWorktree(branch));
    const source = [...byBranch.values()];

    const worktreeTabs = source.map((worktree): WorktreeTab => {
      const branchTasks = tasks.filter((task) => task.branch === worktree.branch);
      // Discard targets for the tab's "Remove worktree" action: the union of the
      // live worktree's owning task ids and every task grouped on this branch
      // (v1 is one-per-branch, so this is normally a single id).
      const taskIds = [...new Set([...worktree.taskIds, ...branchTasks.map((t) => t.id)])];
      return {
        branch: worktree.branch,
        label: worktree.branch,
        taskIds,
        taskCount: branchTasks.length,
        runningCount: branchTasks.filter(isRunning).length,
        dirty: worktree.dirty,
        aheadOfBase: worktree.aheadOfBase,
        behindOfBase: worktree.behindOfBase,
        changedFiles: worktree.changedFiles,
      };
    });

    return [mainTab, ...worktreeTabs];
  }, [tasks, worktrees]);
}
