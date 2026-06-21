import type { Task } from '../bridge';
import { TaskCard } from './TaskCard';

interface ColumnProps {
  title: string;
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function Column({ title, tasks, selectedId, onSelect }: ColumnProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-zinc-800/70 bg-zinc-950/40">
      <div className="flex items-center justify-between border-b border-zinc-800/70 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          {title}
        </h2>
        <span className="rounded-full bg-zinc-800/80 px-1.5 text-[10px] font-medium tabular-nums text-zinc-500">
          {tasks.length}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-auto p-2">
        {tasks.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-zinc-700">Empty</p>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              selected={task.id === selectedId}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}
