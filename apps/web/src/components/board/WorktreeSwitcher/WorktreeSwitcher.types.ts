/** Prop and tab types for the WorktreeSwitcher component. */
import type { Task, WorktreeInfo } from '@/lib/bridge';

/** The active worktree selection: a branch name, or `null` for the Main tab. */
export type ActiveWorktree = string | null;

/** One tab in the switcher: the Main tab (`branch: null`) or a worktree tab. */
export interface WorktreeTab {
  /** The worktree's branch, or `null` for the Main tab. */
  branch: string | null;
  /** Display label — "Main" for the main tab, else the branch name. */
  label: string;
  /** The task ids grouped under this tab — the discard targets for the tab's
   *  "Remove worktree" action (v1 is one-per-branch). Empty for the Main tab. */
  taskIds: string[];
  /** Count of tasks grouped under this tab (Main = run-mode-main tasks). */
  taskCount: number;
  /** How many of this tab's tasks are actively running (in_progress/verifying). */
  runningCount: number;
  /** Whether the backing worktree has uncommitted changes (worktree tabs only). */
  dirty: boolean;
  /** Commits ahead of the project base (worktree tabs only). */
  aheadOfBase: number;
  /** Commits behind the project base (worktree tabs only). */
  behindOfBase: number;
  /** Count of uncommitted changed files (worktree tabs only). */
  changedFiles: number;
}

/** Props for the worktree switcher: the project's tasks, live worktrees, the
 *  active selection, and the select handler. */
export interface WorktreeSwitcherProps {
  /** All tasks for the active project (used for grouping + the Main count). */
  tasks: Task[];
  /** Live worktrees from `listWorktrees`; empty falls back to task branches. */
  worktrees: WorktreeInfo[];
  /** The currently selected tab (`null` = Main). */
  active: ActiveWorktree;
  /** Select a tab (sets the active worktree + filters the board). */
  onSelect: (active: ActiveWorktree) => void;
  /** Remove a worktree tab (discard its checkout + branch). When omitted, the
   *  per-tab actions menu is not rendered. Never called for the Main tab. */
  onRemoveWorktree?: (tab: WorktreeTab) => void;
}
