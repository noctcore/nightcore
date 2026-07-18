import type { Task, WorktreeInfo } from '@/lib/bridge';
import { pluralize } from '@/lib/formatters';

import type {
  ActiveWorktree,
  CollapsedSummary,
  WorktreePartition,
  WorktreeSelectRow,
  WorktreeTab,
} from './WorktreeSwitcher.types';

/** Whether a task is actively running (counts toward a tab's running indicator). */
export function isRunning(task: Task): boolean {
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
export function branchesFromTasks(tasks: Task[]): string[] {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.branch !== null) seen.add(task.branch);
  }
  return [...seen];
}

/** Zeroed monitor fields for a task branch with no live worktree directory. */
export function synthWorktree(branch: string): WorktreeInfo {
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

/** Whether a worktree tab has diverged from base — ahead AND behind, the shape
 *  most likely to conflict on merge, so it earns the trigger's attention badge. */
export function isDiverged(tab: WorktreeTab): boolean {
  return tab.aheadOfBase > 0 && tab.behindOfBase > 0;
}

/**
 * How many tabs (Main included) may show inline before the switcher folds the
 * overflow into the searchable collapsed select. At or below this, every tab
 * renders inline exactly as before; above it, Main stays inline and every worktree
 * collapses. Chosen so up to three worktrees (+ Main) still fit on one row without
 * wrapping.
 */
export const COLLAPSE_THRESHOLD = 4;

/**
 * Split the built tabs into the inline set and the collapsed set. Below the
 * threshold nothing collapses. Above it, Main stays inline and every worktree
 * folds into the collapsed select — including the active one, so the select's
 * trigger can reflect the current selection (its branch label + active styling)
 * and its row can mark itself. Pure so the shell can call it without a hook.
 */
export function partitionWorktreeTabs(tabs: WorktreeTab[]): WorktreePartition {
  if (tabs.length <= COLLAPSE_THRESHOLD) return { inline: tabs, collapsed: [] };
  const inline: WorktreeTab[] = [];
  const collapsed: WorktreeTab[] = [];
  for (const tab of tabs) {
    if (tab.branch === null) inline.push(tab);
    else collapsed.push(tab);
  }
  return { inline, collapsed };
}

/** Fold the collapsed worktrees into the aggregate the trigger surfaces: how many
 *  there are, whether any is running (spinner), and how many have diverged
 *  (attention badge) — so nothing urgent is hidden by the collapse. Pure. */
export function summarizeCollapsed(tabs: WorktreeTab[]): CollapsedSummary {
  let runningCount = 0;
  let runningWorktrees = 0;
  let divergedCount = 0;
  for (const tab of tabs) {
    runningCount += tab.runningCount;
    if (tab.runningCount > 0) runningWorktrees += 1;
    if (isDiverged(tab)) divergedCount += 1;
  }
  return { count: tabs.length, anyRunning: runningWorktrees > 0, runningCount, divergedCount };
}

/** The destructive-confirm body for removing a worktree from its switcher tab. Names
 *  the branch and, when the checkout is dirty, the uncommitted-file count the discard
 *  would throw away — so the confirm spells out exactly what is lost before the tab +
 *  branch vanish. Routes the tab's "Remove worktree" action through the same guard the
 *  card trash + column Clear use. Pure. */
export function worktreeRemovalMessage(tab: WorktreeTab): string {
  const branch = tab.branch ?? 'this worktree';
  const lead = `Discard the ${branch} worktree and its branch?`;
  if (!tab.dirty) return `${lead} This can't be undone.`;
  const changes =
    tab.changedFiles > 0
      ? `${pluralize(tab.changedFiles, 'uncommitted file')} will be lost`
      : 'Uncommitted changes will be lost';
  return `${lead} ${changes}. This can't be undone.`;
}

/** Filter the collapsed tabs by the query (case-insensitive over branch name AND
 *  task titles) and assign each surviving row its flat keyboard-nav index + a
 *  stable option id. An empty query keeps every row. */
export function buildSelectRows(
  tabs: WorktreeTab[],
  query: string,
  baseId: string,
): WorktreeSelectRow[] {
  const q = query.trim().toLowerCase();
  const matches =
    q === ''
      ? tabs
      : tabs.filter(
          (tab) =>
            tab.label.toLowerCase().includes(q) ||
            tab.taskTitles.some((title) => title.toLowerCase().includes(q)),
        );
  return matches.map((tab, index) => ({ tab, index, id: `${baseId}-opt-${index}` }));
}
