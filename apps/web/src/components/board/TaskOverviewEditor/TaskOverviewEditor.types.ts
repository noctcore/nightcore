import type { Task } from '@/lib/bridge';

/** Props for the pre-run editable title/description block (T13). The change handlers
 *  are the drawer's optimistic field updaters (`update_task`), passed from the board's
 *  action group. */
export interface TaskOverviewEditorProps {
  task: Task;
  /** Persist an edited title (commit on blur / Enter; a blank/unchanged value is a no-op). */
  onChangeTitle: (id: string, title: string) => void;
  /** Persist an edited description/prompt (commit on blur / ⌘↵). */
  onChangeDescription: (id: string, description: string) => void;
}
