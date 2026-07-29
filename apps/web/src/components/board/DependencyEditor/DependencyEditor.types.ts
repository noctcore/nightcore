import type { Task } from '@/lib/bridge';

/** Props for {@link DependencyEditor}. The commit handler arrives via
 *  `TaskActionsContext` (`onChangeDependencies`), not as a prop. */
export interface DependencyEditorProps {
  /** The task whose dependency list is being authored. */
  task: Task;
  /** Every task on the board — the candidate pool, and the index that resolves a
   *  declared id to a title/status and powers the cycle guard. */
  tasks: Task[];
  /** Whether the list is editable. The backend accepts a `dependencies` patch at any
   *  time, but the list only MEANS anything before the run starts, so the drawer passes
   *  `false` once a task is running/verifying and the editor renders read-only. */
  editable?: boolean;
}
