/** Board-local derivation and view hooks: dependency-blocking, column grouping,
 *  keyword search, the provider inspector toggle, and the breaker banner. The
 *  board-appearance / background-panel hooks live in `Board.appearance.hooks.ts`. */
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';

import type { Task } from '@/lib/bridge';
import { useWorktreesContext } from '@/lib/worktrees-context';

import type { BreakerInfo } from '../chrome';
import { COLUMNS } from '../status';
import type { UsageHotWindow } from '../usage-hot';
import { filterTasksByWorktree } from '../WorktreeSwitcher';
import type { BoardColumn } from './Board.utils';
import {
  groupTasksByColumn,
  isGhostWorktree,
  matchesQuery,
} from './Board.utils';

/** The Board view hook's result: the search query, its setter, the
 *  worktree-scoped, keyword-filtered, grouped columns, and one stable clear-handler
 *  per column key. */
export interface BoardViewState {
  search: string;
  setSearch: (value: string) => void;
  columns: BoardColumn[];
  /** Stable `onClear` per column key, so a fresh `() => onClearColumn(statuses)`
   *  closure per Board render never defeats `memo(Column)`. */
  clearHandlers: Record<string, () => void>;
}

/** Board view state: the search query plus the derived filtered/grouped columns.
 *  Tasks are first scoped to the active worktree — Main shows run-mode-main
 *  tasks, a worktree tab shows its branch's tasks; the selection is read from the
 *  shared `WorktreesContext` (the same value the switcher sets) — then
 *  keyword-filtered. The blocked-task set is computed by the backend and passed
 *  in as a prop (it depends on the full registry + run state, not just the
 *  visible cards). */
export function useBoardView(
  tasks: Task[],
  onClearColumn: (statuses: Task['status'][]) => void,
): BoardViewState {
  const { activeWorktree, worktrees, setActiveWorktree } = useWorktreesContext();
  const [search, setSearch] = useState('');

  // Self-heal a ghost selection back to Main. Merge (and discard) remove the active
  // worktree and clear its task's branch, but — unlike the switcher's own remove and
  // the project-switch path — nothing resets the scope, so the board stays pinned to
  // the dead branch and shows empty columns. Reset once the branch is gone from BOTH
  // the live worktrees and every task; the effect no-ops (and can't loop) once null.
  useEffect(() => {
    if (isGhostWorktree(activeWorktree, tasks, worktrees)) setActiveWorktree(null);
  }, [activeWorktree, tasks, worktrees, setActiveWorktree]);
  // Decouple the O(n log n) filter/group/sort from each keystroke. The input stays
  // controlled on `search` (updated urgently, so typing never lags), while the
  // columns memo reads a DEFERRED copy: React commits the input immediately and
  // reruns the expensive recompute at low priority, discarding intermediate passes
  // when the user keeps typing. Ties typing latency to input responsiveness, not
  // board size — the 1000+-task target.
  const deferredSearch = useDeferredValue(search);

  const columns = useMemo(() => {
    const scoped = filterTasksByWorktree(tasks, activeWorktree);
    const visible = scoped.filter((task) => matchesQuery(task, deferredSearch));
    return groupTasksByColumn(visible);
  }, [tasks, activeWorktree, deferredSearch]);

  // One stable clear-handler per column, keyed on the static COLUMNS definitions and
  // rebuilt only when `onClearColumn` changes (it never does — `requestClear` is a
  // `useCallback([])`). A fresh `() => onClearColumn(def.statuses)` per render would
  // defeat every `memo(Column)` on any Board re-render, re-reconciling all six
  // columns even when only one column's task list changed.
  const clearHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {};
    for (const def of COLUMNS) handlers[def.key] = () => onClearColumn(def.statuses);
    return handlers;
  }, [onClearColumn]);

  return {
    search,
    setSearch: useCallback((value: string) => setSearch(value), []),
    columns,
    clearHandlers,
  };
}

/** Generic open/hide disclosure state for a self-contained header-triggered sheet.
 *  Shared by the inspector here and the background panel in
 *  `Board.appearance.hooks.ts`. */
export function useDisclosure(): { open: boolean; show: () => void; hide: () => void } {
  const [open, setOpen] = useState(false);
  return {
    open,
    show: useCallback(() => setOpen(true), []),
    hide: useCallback(() => setOpen(false), []),
  };
}

/** Whether to show the circuit-breaker banner: visible while a breaker is set
 *  and not locally dismissed, and re-shown when a fresh breaker arrives. */
export function useBreakerBanner(breaker: BreakerInfo | null): {
  visible: boolean;
  dismiss: () => void;
} {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (breaker === null) setDismissed(false);
  }, [breaker]);

  return {
    visible: breaker !== null && !dismissed,
    dismiss: useCallback(() => setDismissed(true), []),
  };
}

/** Whether to show the usage-pause banner (spec 2026-07-11): visible while the loop
 *  is usage-paused (`usagePause` set) and not locally dismissed, and re-shown when a
 *  fresh episode arrives — the dismissed latch resets the moment the pause clears
 *  (`usagePause === null`), so the next false→true transition surfaces the banner
 *  again. Mirrors {@link useBreakerBanner}; there is NO Resume button (the loop
 *  auto-resumes when usage cools), only a Dismiss. */
export function useUsagePauseBanner(usagePause: UsageHotWindow | null): {
  visible: boolean;
  dismiss: () => void;
} {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (usagePause === null) setDismissed(false);
  }, [usagePause]);

  return {
    visible: usagePause !== null && !dismissed,
    dismiss: useCallback(() => setDismissed(true), []),
  };
}
