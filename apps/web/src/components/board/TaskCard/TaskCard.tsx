import { Badge } from '@/components/ui';
import { formatCost } from '../status';
import { TaskStatusDot } from '../TaskStatusDot';
import type { TaskCardProps } from './TaskCard.types';

export function TaskCard({ task, selected, onSelect }: TaskCardProps) {
  const failed = task.status === 'failed';
  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      className={`group w-full rounded-xl border bg-card p-3.5 text-left transition-colors ${
        failed
          ? 'border-destructive/45 shadow-[0_0_0_1px_var(--nc-destructive)]'
          : selected
            ? 'border-primary/60 shadow-[0_0_0_1px_var(--nc-primary)]'
            : 'border-border hover:border-white/20'
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Badge>
          {task.model ?? 'default model'}
        </Badge>
        <span className="ml-auto flex items-center gap-2">
          {task.costUsd !== null && (
            <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
              {formatCost(task.costUsd)}
            </span>
          )}
          <TaskStatusDot status={task.status} glow />
        </span>
      </div>
      <div className="text-sm font-semibold leading-snug text-foreground">
        {task.title || 'Untitled task'}
      </div>
      {task.description.trim().length > 0 && (
        <div className="mt-1.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
          {task.description}
        </div>
      )}
      {failed && task.error !== null && (
        <div className="mt-2.5 truncate rounded-md bg-destructive/[0.12] px-2 py-1 font-mono text-[9.5px] text-destructive">
          {task.error}
        </div>
      )}
    </button>
  );
}
