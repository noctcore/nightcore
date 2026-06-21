import type { Task } from '../bridge';
import { COLUMNS } from '../status';
import { Column } from './Column';

interface BoardProps {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function Board({ tasks, selectedId, onSelect }: BoardProps) {
  return (
    <div className="grid h-full grid-cols-4 gap-3 p-3">
      {COLUMNS.map((col) => {
        const colTasks = tasks
          .filter((t) => col.statuses.includes(t.status))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return (
          <Column
            key={col.key}
            title={col.title}
            tasks={colTasks}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}
