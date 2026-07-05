/** Prop and tab types for the WorktreeSwitcher component. */
import type { ChangeEvent, FocusEvent, KeyboardEvent, RefObject } from 'react';

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
  /** Titles of the tasks grouped under this tab. Feeds the collapsed select's
   *  search so a worktree is findable by its work, not just its branch name. */
  taskTitles: string[];
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

/** How the switcher splits its tabs once it overflows: Main stays pinned inline
 *  and every worktree (the active one included, so the collapsed select's trigger
 *  can reflect the current selection) folds into the searchable collapsed select. */
export interface WorktreePartition {
  /** Tabs rendered inline as today's `role="tab"` buttons (Main when collapsed). */
  inline: WorktreeTab[];
  /** Worktree tabs folded into the collapsed searchable select (never Main). */
  collapsed: WorktreeTab[];
}

/** Aggregate status of the collapsed worktrees, surfaced on the select trigger so
 *  nothing urgent (a running worktree, a diverged branch) hides in the dropdown. */
export interface CollapsedSummary {
  /** How many worktrees are folded into the collapsed select. */
  count: number;
  /** Whether any collapsed worktree has an active run (drives the trigger spinner). */
  anyRunning: boolean;
  /** Total running tasks across the collapsed worktrees (for the a11y label). */
  runningCount: number;
  /** Collapsed worktrees that have diverged (ahead AND behind base) — the
   *  attention badge count so a likely-conflict branch never hides. */
  divergedCount: number;
}

/** One row in the collapsed select's listbox: a worktree tab plus its flat
 *  keyboard-nav index and a stable option id (for `aria-activedescendant`). */
export interface WorktreeSelectRow {
  tab: WorktreeTab;
  index: number;
  id: string;
}

/** The view the collapsed-select hook hands its presentation shell: the filtered
 *  rows, the aggregate, ephemeral open/highlight state, the refs the shell
 *  attaches, and the trigger/input handlers. */
export interface WorktreeCollapsedSelectView {
  /** Whether the dropdown panel is open. */
  open: boolean;
  /** The live search query (filters by branch name + task titles). */
  query: string;
  /** The filtered, flat-indexed rows for the listbox. */
  rows: WorktreeSelectRow[];
  /** Aggregate status shown on the trigger. */
  summary: CollapsedSummary;
  /** The collapsed tab matching the active selection, or `null` (Main/other). */
  activeTab: WorktreeTab | null;
  /** The highlighted (active-descendant) row index, or -1 when none. */
  highlight: number;
  /** The listbox element id (wired to `aria-controls`). */
  listboxId: string;
  /** The highlighted option's id for `aria-activedescendant`, or undefined. */
  activeOptionId: string | undefined;
  /** Ref for the disclosure trigger button (focus returns here on Esc/select). */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** Ref for the search input (focused when the panel opens). */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Ref for the root wrapper (outside-pointer close boundary). */
  rootRef: RefObject<HTMLDivElement | null>;
  /** Toggle the panel open/closed (trigger click). */
  onTriggerClick: () => void;
  /** Trigger keydown: ArrowDown/Up opens the panel onto the list. */
  onTriggerKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  /** Search input change. */
  onQueryChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** Search input keydown: arrow/Home/End navigate, Enter selects, Esc closes. */
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** Move the highlight to a row (pointer hover). */
  onHighlight: (index: number) => void;
  /** Close the panel when focus leaves the root (keyboard tab-out). */
  onContainerBlur: (e: FocusEvent<HTMLDivElement>) => void;
  /** Select a worktree by branch (pointer click on a row). */
  selectBranch: (branch: string | null) => void;
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
