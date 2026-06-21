import type { Task } from '@/lib/bridge';
import { COLUMNS, type ColumnDef } from '../status';

export interface BoardColumn {
  def: ColumnDef;
  tasks: Task[];
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
