import { TaskCard } from '../TaskCard';
import type { ColumnProps } from './Column.types';

export function Column({ title, tasks, selectedId, onSelect }: ColumnProps) {
  return (
    <div className="flex w-[300px] shrink-0 flex-col rounded-[13px] border border-border bg-white/[0.015]">
      <div className="flex items-center gap-2 px-3.5 pb-3 pt-3.5">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <span className="rounded-md bg-white/[0.05] px-1.5 py-px font-mono text-[11px] tabular-nums text-muted-foreground">
          {tasks.length}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2.5 overflow-auto px-3 pb-3">
        {tasks.length === 0 ? (
          <p className="rounded-[11px] border border-dashed border-border px-3.5 py-6 text-center text-xs text-muted-foreground">
            Nothing here yet
          </p>
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
