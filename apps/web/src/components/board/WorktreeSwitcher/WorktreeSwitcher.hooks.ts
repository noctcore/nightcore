/** WorktreeSwitcher derivation: per-worktree task filtering, tab building, and the
 *  overflow-collapse partition + searchable-select state machine. */
import type { ChangeEvent, FocusEvent, KeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { Task, WorktreeInfo } from '@/lib/bridge';

import type {
  ActiveWorktree,
  CollapsedSummary,
  WorktreeCollapsedSelectView,
  WorktreePartition,
  WorktreeSelectRow,
  WorktreeTab,
} from './WorktreeSwitcher.types';

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
      taskTitles: mainTasks.map((t) => t.title),
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
        taskTitles: branchTasks.map((t) => t.title),
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

/**
 * How many tabs (Main included) may show inline before the switcher folds the
 * overflow into the searchable collapsed select. At or below this, every tab
 * renders inline exactly as before; above it, Main stays inline and every worktree
 * collapses. Chosen so up to three worktrees (+ Main) still fit on one row without
 * wrapping.
 */
export const COLLAPSE_THRESHOLD = 4;

/** Whether a worktree tab has diverged from base — ahead AND behind, the shape
 *  most likely to conflict on merge, so it earns the trigger's attention badge. */
function isDiverged(tab: WorktreeTab): boolean {
  return tab.aheadOfBase > 0 && tab.behindOfBase > 0;
}

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

/** Filter the collapsed tabs by the query (case-insensitive over branch name AND
 *  task titles) and assign each surviving row its flat keyboard-nav index + a
 *  stable option id. An empty query keeps every row. */
function buildSelectRows(
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

/** Inputs the collapsed-select hook needs from its shell. */
interface UseWorktreeCollapsedSelectArgs {
  /** The collapsed worktree tabs (never includes Main). */
  tabs: WorktreeTab[];
  /** The active selection, so the matching row/trigger can mark itself. */
  active: ActiveWorktree;
  /** Select a worktree (filters the board, exactly like clicking a tab). */
  onSelect: (active: ActiveWorktree) => void;
}

/**
 * Open/query/highlight state + keyboard model for the collapsed worktree select.
 * The rows and aggregate are pure derivations of the collapsed tabs and query;
 * only open/query/highlight are ephemeral. Mirrors the BranchPicker combobox model
 * — a search input drives `aria-activedescendant` over a `role="listbox"` — behind
 * a disclosure button that carries the aggregate. Selecting or Esc returns focus
 * to the trigger; an outside pointer or focus leaving the root closes the panel.
 */
export function useWorktreeCollapsedSelect({
  tabs,
  active,
  onSelect,
}: UseWorktreeCollapsedSelectArgs): WorktreeCollapsedSelectView {
  const baseId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rawHighlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => buildSelectRows(tabs, query, baseId), [tabs, query, baseId]);
  const summary = useMemo(() => summarizeCollapsed(tabs), [tabs]);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.branch === active) ?? null,
    [tabs, active],
  );

  const count = rows.length;
  // Clamp so a shrinking list never leaves the highlight pointing past the end.
  const highlight = count === 0 ? -1 : Math.min(Math.max(rawHighlight, 0), count - 1);

  // While open: focus the search input, and close on an outside pointer press so a
  // click elsewhere on the board dismisses the panel (focus-leaving-root is handled
  // by the shell's onBlur, this covers clicks on non-focusable regions).
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function reset(): void {
    setOpen(false);
    setQuery('');
    setHighlight(0);
  }

  function pick(branch: string | null): void {
    onSelect(branch);
    reset();
    triggerRef.current?.focus();
  }

  function onTriggerClick(): void {
    setOpen((v) => !v);
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>): void {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
      e.preventDefault();
      setOpen(true);
      setHighlight(e.key === 'ArrowDown' ? 0 : Math.max(count - 1, 0));
    }
  }

  function onQueryChange(e: ChangeEvent<HTMLInputElement>): void {
    setQuery(e.target.value);
    setHighlight(0);
    if (!open) setOpen(true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (count > 0) setHighlight((highlight + 1) % count);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (count > 0) setHighlight((highlight - 1 + count) % count);
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (count > 0) setHighlight(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      if (count > 0) setHighlight(count - 1);
    } else if (e.key === 'Enter') {
      const row = rows.find((r) => r.index === highlight);
      if (row !== undefined) {
        e.preventDefault();
        pick(row.tab.branch);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      reset();
      triggerRef.current?.focus();
    }
  }

  function onHighlight(index: number): void {
    setHighlight(index);
  }

  function onContainerBlur(e: FocusEvent<HTMLDivElement>): void {
    if (!e.currentTarget.contains(e.relatedTarget)) reset();
  }

  const activeRow = highlight < 0 ? undefined : rows.find((r) => r.index === highlight);

  return {
    open,
    query,
    rows,
    summary,
    activeTab,
    highlight,
    listboxId: `${baseId}-listbox`,
    activeOptionId: open ? activeRow?.id : undefined,
    triggerRef,
    inputRef,
    rootRef,
    onTriggerClick,
    onTriggerKeyDown,
    onQueryChange,
    onKeyDown,
    onHighlight,
    onContainerBlur,
    selectBranch: pick,
  };
}
