/** Props for the NewTaskForm dialog. */
import type { CreateTaskOptions, RunMode, TaskKind } from '@/lib/bridge';

/** Props for the create-task dialog: the create callback (title, description,
 *  kind, run mode, plus optional overrides) and the close handler. */
export interface NewTaskFormProps {
  /** Presence flag — the sheet slides in/out and stays mounted while closed. */
  open: boolean;
  onCreate: (
    title: string,
    description: string,
    kind: TaskKind,
    runMode: RunMode,
    options?: CreateTaskOptions,
  ) => Promise<void>;
  onClose: () => void;
}
