import { useMemo } from 'react';
import type { Task, WorktreeInfo } from '@/lib/bridge';
import type { ActiveWorktree, WorktreeTab } from './WorktreeSwitcher.types';

/** Whether a task is actively running (counts toward a tab's running indicator). */
function isRunning(task: Task): boolean {
  return task.status === 'in_progress' || task.status === 'verifying';
}

/** Filter the board to the active worktree (M4.6, §D.3): the Main tab shows
 *  `run_mode === 'main'` tasks; a worktree tab shows tasks whose branch matches.
 *  Exported so the board's view hook and the switcher derive identical sets. */
export function filterTasksByWorktree(tasks: Task[], active: ActiveWorktree): Task[] {
  if (active === null) return tasks.filter((task) => task.runMode === 'main');
  return tasks.filter((task) => task.branch === active);
}

/** The distinct worktree branches a task set references — the fallback tab source
 *  when `listWorktrees` is empty (outside Tauri, or before the first read). */
function branchesFromTasks(tasks: Task[]): string[] {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.runMode === 'worktree' && task.branch !== null) seen.add(task.branch);
  }
  return [...seen];
}

/** Build the switcher's tabs: a Main tab plus one per live worktree (falling back
 *  to distinct task branches when `listWorktrees` is empty). Each tab carries its
 *  task/running counts and — for worktree tabs — the dirty/ahead monitor state. */
export function useWorktreeTabs(tasks: Task[], worktrees: WorktreeInfo[]): WorktreeTab[] {
  return useMemo(() => {
    const mainTasks = filterTasksByWorktree(tasks, null);
    const mainTab: WorktreeTab = {
      branch: null,
      label: 'Main',
      taskCount: mainTasks.length,
      runningCount: mainTasks.filter(isRunning).length,
      dirty: false,
      aheadOfBase: 0,
    };

    const source: WorktreeInfo[] =
      worktrees.length > 0
        ? worktrees
        : branchesFromTasks(tasks).map((branch) => ({
            branch,
            path: '',
            taskIds: [],
            dirty: false,
            aheadOfBase: 0,
          }));

    const worktreeTabs = source.map((worktree): WorktreeTab => {
      const branchTasks = tasks.filter((task) => task.branch === worktree.branch);
      return {
        branch: worktree.branch,
        label: worktree.branch,
        taskCount: branchTasks.length,
        runningCount: branchTasks.filter(isRunning).length,
        dirty: worktree.dirty,
        aheadOfBase: worktree.aheadOfBase,
      };
    });

    return [mainTab, ...worktreeTabs];
  }, [tasks, worktrees]);
}
