import type { TaskKind } from '@/lib/bridge';

export interface NewTaskFormProps {
  onCreate: (title: string, description: string, kind: TaskKind) => Promise<void>;
  onClose: () => void;
}
