import { memo } from 'react';
import { TrashIcon } from '@/components/ui';
import { TaskCard } from '../TaskCard';
import { moveTargetsFor } from '../status';
import { DRAG_TASK_ID, useColumnDrop } from './Column.hooks';
import type { ColumnProps } from './Column.types';

/** A board column: a colored status dot + label + count header (with an optional
 *  roadmap badge and a Clear affordance for Verified/Failed), over its task
 *  cards. Width tracks the design (Failed is narrower). Presentational — all
 *  state and bridge actions are owned by the board.
 *
 *  Memoized (C6): on a board-wide `nc:session` delta the Board re-renders, but a
 *  column whose props are referentially stable skips. `logCounts` is a fresh
 *  object per delta so a column DOES re-render, but its memoized `TaskCard`s read
 *  a primitive `logCount` and skip unless their own count changed — so the storm
 *  collapses from "every card" to "only the card whose stream advanced". */
function ColumnImpl({
  title,
  tasks,
  dotColor,
  badge,
  clearable,
  selectedId,
  blockedIds,
  promptIds,
  logCounts,
  dropStatus,
  emptyText = 'Nothing here yet',
  onSelect,
  onRun,
  onCancel,
  onDelete,
  onMoveTask,
  onApprove,
  onRefine,
  onCommit,
  onMerge,
  onClear,
}: ColumnProps) {
  const showClear = clearable === true && tasks.length > 0;
  const drop = useColumnDrop(dropStatus, onMoveTask);
  return (
    <div
      className={`flex shrink-0 flex-col rounded-[13px] border bg-white/[0.015] transition-colors ${
        drop.isOver ? 'border-primary/60 bg-primary/[0.04]' : 'border-border'
      }`}
      style={{ width: title === 'Failed' ? 248 : 296 }}
      aria-dropeffect={drop.droppable ? 'move' : 'none'}
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
      <div
        className="flex flex-1 flex-col gap-2.5 overflow-auto px-3 pb-3"
        {...drop.dropProps}
      >
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
              needsApproval={promptIds?.has(task.id) ?? false}
              logCount={logCounts[task.id] ?? 0}
              draggable={onMoveTask !== undefined}
              moveTargets={onMoveTask !== undefined ? moveTargetsFor(task.status) : undefined}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TASK_ID, task.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onSelect={onSelect}
              onMoveTask={onMoveTask}
              onRun={onRun}
              onCancel={onCancel}
              onDelete={onDelete}
              onApprove={onApprove}
              onRefine={onRefine}
              onCommit={onCommit}
              onMerge={onMerge}
            />
          ))
        )}
      </div>
    </div>
  );
}

export const Column = memo(ColumnImpl);
