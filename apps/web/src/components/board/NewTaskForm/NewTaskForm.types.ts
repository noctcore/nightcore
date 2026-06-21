import type { RunMode, TaskKind } from '@/lib/bridge';

export interface NewTaskFormProps {
  onCreate: (
    title: string,
    description: string,
    kind: TaskKind,
    runMode: RunMode,
  ) => Promise<void>;
  onClose: () => void;
}
