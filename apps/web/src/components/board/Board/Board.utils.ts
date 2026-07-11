import type { Task, WorktreeInfo } from '@/lib/bridge';
import type { ActiveWorktree } from '@/lib/worktrees-context';

import { type ColumnDef, COLUMNS } from '../status';

/** A board column paired with the tasks currently grouped into it. */
export interface BoardColumn {
  def: ColumnDef;
  tasks: Task[];
}

/** One resolved dependency of a task — its real id, the depended-on task's title (or
 *  `null` when it no longer exists), and whether it's satisfied (Done). The
 *  human-readable replacement for the old raw-id `blocked · 3f2a9c…` chip. */
export interface DependencyChip {
  id: string;
  title: string | null;
  satisfied: boolean;
}

/**
 * Resolve a task's `dependencies` (task ids) to human-readable chips — driven by the
 * REAL id list against the live task index, replacing the fragile title-matching
 * `computeBlockedIds` web util (which looked deps up as titles and so never matched the
 * id-based backend). A missing dependency (deleted task) reads as unsatisfied with a
 * `null` title so the chip can say "unknown". Pure.
 */
export function resolveDependencies(task: Task, byId: Map<string, Task>): DependencyChip[] {
  return task.dependencies.map((id) => {
    const dep = byId.get(id);
    return { id, title: dep?.title ?? null, satisfied: dep?.status === 'done' };
  });
}

/**
 * A per-task map of resolved dependency chips, built once over the whole task list for
 * the board to thread to each card. Only tasks that actually declare dependencies get an
 * entry, so a dependency-free card is passed `undefined` (a stable prop that never
 * defeats the card memo on a stream flush). Pure.
 */
export function dependencyChipsByTask(tasks: Task[]): Map<string, DependencyChip[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map<string, DependencyChip[]>();
  for (const task of tasks) {
    if (task.dependencies.length > 0) {
      out.set(task.id, resolveDependencies(task, byId));
    }
  }
  return out;
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

/**
 * Whether the active worktree selection is a "ghost" — its branch no longer
 * exists on any live worktree directory OR any task. A merge (or a discard) removes
 * the worktree AND clears the owning task's branch (`t.branch = None`), so the tab
 * vanishes but the shared selection lingers, and `filterTasksByWorktree` then scopes
 * the board to a dead branch → every column renders empty until the user switches
 * projects. Main (`null`) is never a ghost. Mirrors the union `useWorktreeTabs`
 * builds tabs from (live worktrees ∪ task branches), so "no tab exists for `active`"
 * ⇔ ghost — meaning a still-live worktree, or a task whose worktree dir hasn't
 * materialized yet, is correctly NOT treated as stale.
 */
export function isGhostWorktree(
  active: ActiveWorktree,
  tasks: Task[],
  worktrees: WorktreeInfo[],
): boolean {
  if (active === null) return false;
  if (worktrees.some((worktree) => worktree.branch === active)) return false;
  return !tasks.some((task) => task.branch === active);
}
