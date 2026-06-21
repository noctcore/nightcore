import type { Task } from '@/lib/bridge';

export interface ColumnProps {
  title: string;
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}
