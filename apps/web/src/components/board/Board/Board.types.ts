import type { Task } from '@/lib/bridge';

export interface BoardProps {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}
