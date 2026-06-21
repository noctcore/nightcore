import type { Task } from '@/lib/bridge';

export interface TaskCardProps {
  task: Task;
  selected: boolean;
  onSelect: (id: string) => void;
}
