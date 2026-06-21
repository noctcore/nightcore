import { TrashIcon } from '@/components/ui';
import { TaskCard } from '../TaskCard';
import type { ColumnProps } from './Column.types';

/** A board column: a colored status dot + label + count header (with an optional
 *  roadmap badge and a Clear affordance for Verified/Failed), over its task
 *  cards. Width tracks the design (Failed is narrower). Presentational — all
 *  state and bridge actions are owned by the board. */
export function Column({
  title,
  tasks,
  dotColor,
  badge,
  clearable,
  selectedId,
  blockedIds,
  logCounts,
  emptyText = 'Nothing here yet',
  onSelect,
  onRun,
  onCancel,
  onDelete,
  onClear,
}: ColumnProps) {
  const showClear = clearable === true && tasks.length > 0;
  return (
    <div
      className="flex shrink-0 flex-col rounded-[13px] border border-border bg-white/[0.015]"
      style={{ width: title === 'Failed' ? 248 : 296 }}
    >
      <div className="flex items-center gap-2 px-3.5 pb-3 pt-3.5">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: dotColor, boxShadow: `0 0 8px ${dotColor}` }}
        />
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <span className="rounded-md bg-white/[0.05] px-1.5 py-px font-mono text-[11px] tabular-nums text-muted-foreground">
          {tasks.length}
        </span>
        {badge !== undefined && (
          <span className="rounded bg-primary/[0.18] px-1 py-px font-mono text-[8px] tracking-[0.04em] text-primary">
            {badge}
          </span>
        )}
        {showClear && (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
          >
            <TrashIcon size={13} />
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2.5 overflow-auto px-3 pb-3">
        {tasks.length === 0 ? (
          <p className="rounded-[11px] border border-dashed border-border px-3.5 py-6 text-center text-xs text-muted-foreground">
            {emptyText}
          </p>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              selected={task.id === selectedId}
              blocked={blockedIds.has(task.id)}
              logCount={logCounts[task.id] ?? 0}
              onSelect={onSelect}
              onRun={onRun}
              onCancel={onCancel}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}
