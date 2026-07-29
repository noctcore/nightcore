/** Pure joins for the run-order sheet: the backend projection is authoritative about the
 *  ORDER, this module only resolves its ids to human titles. Nothing here re-sorts. */
import type { RunOrderProjection } from '@/lib/bridge';
import type { Task } from '@/lib/bridge';

import type { RunOrderRow } from './RunOrderPanel.types';

/** A deleted dependency still blocks the run forever (the coordinator fails closed), so it
 *  is named rather than dropped. */
const DELETED = 'a deleted task';

function titleOf(id: string, byId: Map<string, Task>): string {
  const task = byId.get(id);
  if (task === undefined) return DELETED;
  return task.title.trim() === '' ? 'Untitled task' : task.title;
}

/** Join the projection's ordered entries with their tasks, PRESERVING the backend order.
 *  An entry whose task is absent from `tasks` (a delete racing the refetch) is dropped —
 *  a row with no title would be noise. Pure. */
export function runOrderRows(projection: RunOrderProjection, tasks: Task[]): RunOrderRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows: RunOrderRow[] = [];
  for (const entry of projection.entries) {
    if (!byId.has(entry.taskId)) continue;
    rows.push({
      id: entry.taskId,
      title: titleOf(entry.taskId, byId),
      position: entry.position,
      wave: entry.wave,
      startsNow: entry.startsNow,
      blockedBy: entry.blockedBy.map((dep) => titleOf(dep, byId)),
    });
  }
  return rows;
}

/** The launchable tasks that can NEVER become eligible as the board stands (a missing or
 *  failed dependency, or a cycle), resolved to titles. Surfaced as its own group — these
 *  have no position, and pretending otherwise would be the exact dishonesty the run-order
 *  work removes. Pure. */
export function unreachableRows(
  projection: RunOrderProjection,
  tasks: Task[],
): { id: string; title: string }[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return projection.unreachable
    .filter((id) => byId.has(id))
    .map((id) => ({ id, title: titleOf(id, byId) }));
}
