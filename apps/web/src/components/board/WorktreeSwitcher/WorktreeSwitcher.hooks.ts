/** WorktreeSwitcher derivation: per-worktree task filtering, tab building, and the
 *  overflow-collapse partition + searchable-select state machine. */
import type { ChangeEvent, FocusEvent, KeyboardEvent } from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { Task, WorktreeInfo } from '@/lib/bridge';

import type {
  ActiveWorktree,
  WorktreeCollapsedSelectView,
  WorktreeTab,
} from './WorktreeSwitcher.types';
import {
  branchesFromTasks,
  buildSelectRows,
  filterTasksByWorktree,
  isRunning,
  summarizeCollapsed,
  synthWorktree,
} from './WorktreeSwitcher.utils';

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

/** The remove-worktree confirmation state + triggers. The kebab "Remove worktree"
 *  item no longer discards instantly — it opens a shared destructive `ConfirmDialog`
 *  (the same guard the card trash + column Clear route through), so a dirty `●N`
 *  worktree can't be thrown away on a single misclick. `request` parks the pending
 *  tab; `confirm` runs the real discard; `cancel` dismisses. State lives here, never
 *  in the switcher component body. */
export interface WorktreeRemovalConfirm {
  /** The worktree tab awaiting removal confirmation, or `null`. */
  pending: WorktreeTab | null;
  /** Open the confirmation for a tab (the kebab "Remove worktree" item). */
  request: (tab: WorktreeTab) => void;
  /** Discard the pending worktree and close the dialog. */
  confirm: () => void;
  /** Dismiss the dialog without discarding. */
  cancel: () => void;
}

export function useWorktreeRemovalConfirm(
  onRemove: (tab: WorktreeTab) => void,
): WorktreeRemovalConfirm {
  const [pending, setPending] = useState<WorktreeTab | null>(null);
  const request = useCallback((tab: WorktreeTab) => setPending(tab), []);
  const cancel = useCallback(() => setPending(null), []);
  const confirm = useCallback(() => {
    setPending((tab) => {
      if (tab !== null) onRemove(tab);
      return null;
    });
  }, [onRemove]);
  return { pending, request, confirm, cancel };
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
