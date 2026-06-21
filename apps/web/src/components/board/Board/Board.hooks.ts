import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Task } from '@/lib/bridge';
import { COLUMNS, type ColumnDef } from '../status';
import type { BreakerInfo } from './Board.types';

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

export interface BoardViewState {
  search: string;
  setSearch: (value: string) => void;
  columns: BoardColumn[];
  blockedIds: Set<string>;
}

/** Board view state: the search query plus the derived filtered/grouped columns
 *  and blocked-task set. */
export function useBoardView(tasks: Task[]): BoardViewState {
  const [search, setSearch] = useState('');

  const blockedIds = useMemo(() => computeBlockedIds(tasks), [tasks]);
  const columns = useMemo(() => {
    const visible = tasks.filter((task) => matchesQuery(task, search));
    return groupTasksByColumn(visible);
  }, [tasks, search]);

  return {
    search,
    setSearch: useCallback((value: string) => setSearch(value), []),
    columns,
    blockedIds,
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
