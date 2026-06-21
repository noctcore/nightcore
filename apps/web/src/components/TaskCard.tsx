import type { Task } from '../bridge';
import { formatCost } from '../status';
import { StatusDot } from './StatusDot';

interface TaskCardProps {
  task: Task;
  selected: boolean;
  onSelect: (id: string) => void;
}

export function TaskCard({ task, selected, onSelect }: TaskCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      className={`group w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        selected
          ? 'border-sky-600/70 bg-sky-950/30'
          : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-900'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-1.5">
          <StatusDot status={task.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-100">
            {task.title || 'Untitled task'}
          </span>
          {task.description.trim().length > 0 && (
            <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-zinc-500">
              {task.description}
            </span>
          )}
        </span>
      </div>
      {task.costUsd !== null && (
        <div className="mt-2 flex justify-end">
          <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-zinc-400">
            {formatCost(task.costUsd)}
          </span>
        </div>
      )}
    </button>
  );
}
