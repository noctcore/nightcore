/** Props for the NewTaskForm dialog. */
import type { CreateTaskOptions, RunMode, TaskKind } from '@/lib/bridge';

/** Props for the create-task dialog: the create callback (title, description,
 *  kind, run mode, plus optional overrides) and the close handler. */
export interface NewTaskFormProps {
  onCreate: (
    title: string,
    description: string,
    kind: TaskKind,
    runMode: RunMode,
    options?: CreateTaskOptions,
  ) => Promise<void>;
  onClose: () => void;
}
