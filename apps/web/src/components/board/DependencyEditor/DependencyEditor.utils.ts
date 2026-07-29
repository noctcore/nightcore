/** Pure dependency-graph helpers for the editor. No React, no side effects — so the
 *  cycle guard (the one rule the backend can't tell you about before you save) is
 *  unit-testable on its own. */
import type { Task } from '@/lib/bridge';

/** One resolvable dependency row the editor renders: the real task id, its title, and
 *  whether the coordinator already counts it satisfied (`done`). A dangling id (the task
 *  was deleted) has a `null` title and is never satisfied — the backend fails CLOSED on
 *  it, so the editor must surface it rather than hide it. */
export interface DependencyRow {
  id: string;
  title: string | null;
  satisfied: boolean;
}

/** Resolve a task's declared dependency ids to editor rows, in declaration order. Pure. */
export function dependencyRows(task: Task, byId: Map<string, Task>): DependencyRow[] {
  return task.dependencies.map((id) => {
    const dep = byId.get(id);
    return { id, title: dep?.title ?? null, satisfied: dep?.status === 'done' };
  });
}

/**
 * Whether adding `candidateId` as a dependency of `taskId` would create a CYCLE.
 *
 * This is the guard the backend cannot give you as feedback: `deps_satisfied` fails
 * closed, so a cycle doesn't error — it just means neither task is ever eligible again,
 * silently. Walking the existing edges before the save turns that trap into a disabled
 * row with a reason.
 *
 * True when `candidateId` is `taskId` itself, or when `taskId` is already reachable from
 * `candidateId` by following dependency edges. Traversal is visited-guarded, so a
 * PRE-EXISTING cycle in the stored graph can't hang the walk. Pure.
 */
export function wouldCycle(
  taskId: string,
  candidateId: string,
  byId: Map<string, Task>,
): boolean {
  if (taskId === candidateId) return true;
  const seen = new Set<string>();
  const stack = [candidateId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current === taskId) return true;
    const deps = byId.get(current)?.dependencies ?? [];
    for (const dep of deps) if (!seen.has(dep)) stack.push(dep);
  }
  return false;
}

/** A pickable dependency candidate: a task, plus why it can't be picked (`null` = it can). */
export interface DependencyCandidate {
  task: Task;
  /** Human reason the row is disabled, or `null` when the dependency is addable. */
  blockedReason: string | null;
}

/**
 * The candidate list for the editor's picker: every OTHER task, keyword-filtered,
 * ordered the way the board's launch order runs (`createdAt`, then `id`) so the list
 * reads in the same sequence the coordinator would execute.
 *
 * Already-declared dependencies are dropped entirely (nothing to add). A candidate that
 * would close a cycle stays VISIBLE but disabled with a reason — silently hiding it would
 * leave the user hunting for a task that is right there. Pure.
 */
export function dependencyCandidates(
  task: Task,
  tasks: Task[],
  query: string,
): DependencyCandidate[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const declared = new Set(task.dependencies);
  const q = query.trim().toLowerCase();
  return tasks
    .filter((candidate) => candidate.id !== task.id && !declared.has(candidate.id))
    .filter((candidate) => q === '' || candidate.title.toLowerCase().includes(q))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((candidate) => ({
      task: candidate,
      blockedReason: wouldCycle(task.id, candidate.id, byId)
        ? 'Would create a dependency cycle — neither task could ever run'
        : null,
    }));
}
