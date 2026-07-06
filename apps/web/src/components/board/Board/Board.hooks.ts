/** Board-local derivation and view hooks: dependency-blocking, column grouping,
 *  keyword search, the provider inspector toggle, and the breaker banner. The
 *  board-appearance / background-panel hooks live in `Board.appearance.hooks.ts`. */
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';

import type { Task } from '@/lib/bridge';
import { useWorktreesContext } from '@/lib/worktrees-context';

import type { BreakerInfo } from '../chrome';
import { type ColumnDef,COLUMNS } from '../status';
import { filterTasksByWorktree } from '../WorktreeSwitcher';

/** A board column paired with the tasks currently grouped into it. */
export interface BoardColumn {
  def: ColumnDef;
  tasks: Task[];
}

/** Statuses that count as "finished" when resolving a dependency. */
const SETTLED: ReadonlySet<Task['status']> = new Set(['done']);

/** A backlog task is blocked when any of its dependencies (matched by task
 *  title) is not yet verified. Returns the set of blocked task ids. */
export function computeBlockedIds(tasks: Task[]): Set<string> {
  const byTitle = new Map(tasks.map((t) => [t.title, t]));
  const blocked = new Set<string>();
  for (const task of tasks) {
    if (task.status !== 'backlog' && task.status !== 'ready') continue;
    const isBlocked = task.dependencies.some((dep) => {
      const target = byTitle.get(dep);
      return target !== undefined && !SETTLED.has(target.status);
    });
    if (isBlocked) blocked.add(task.id);
  }
  return blocked;
}

/** Group tasks into the board's columns, newest-updated first within each. */
export function groupTasksByColumn(tasks: Task[]): BoardColumn[] {
  return COLUMNS.map((def) => ({
    def,
    tasks: tasks
      .filter((task) => def.statuses.includes(task.status))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }));
}

/** Case-insensitive title/description keyword match. Empty query matches all. */
export function matchesQuery(task: Task, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return `${task.title} ${task.description}`.toLowerCase().includes(q);
}

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
  const { activeWorktree } = useWorktreesContext();
  const [search, setSearch] = useState('');
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
