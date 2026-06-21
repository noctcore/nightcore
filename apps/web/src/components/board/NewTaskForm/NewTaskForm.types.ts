import type { CreateTaskOptions, RunMode, TaskKind } from '@/lib/bridge';

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
