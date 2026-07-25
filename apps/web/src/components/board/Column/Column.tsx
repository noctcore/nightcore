import { memo } from 'react';

import { TrashIcon } from '@/components/ui';

import type { DependencyChip } from '../Board/Board.utils';
import { canDragStatus } from '../status';
import { TaskCard } from '../TaskCard';
import { useColumn } from './Column.hooks';
import type { ColumnProps } from './Column.types';

/** Stable empty default so a story that omits `dependencyChipsById` doesn't mint a fresh
 *  map per render (which would churn the memoized cards). */
const NO_DEP_CHIPS: Map<string, DependencyChip[]> = new Map();

/** A board column: a colored status dot + label + count header (with a Clear
 *  affordance for Backlog/Done/Failed), over its task cards. Failed renders
 *  narrower than the rest. Presentational — all state and bridge actions are
 *  owned by the board.
 *
 *  Drag-and-drop (@dnd-kit): the whole column shell is a droppable keyed on its
 *  primary status; the board's `<DndContext>` resolves a cross-column drop to a
 *  status move. The card list is virtualized (`@tanstack/react-virtual`) so a 50+
 *  card column only mounts the visible rows — a `<DragOverlay>` (rendered by the
 *  board) keeps a dragged card visible even after its source row scrolls out.
 *
 *  Memoized: on a board-wide `nc:session` delta the Board re-renders, but a
 *  column whose props are referentially stable skips. `logCounts` is a fresh
 *  object per delta so a column DOES re-render, but each virtualized row renders
 *  the memoized `TaskCard` reading a primitive `logCount` and skips unless its own
 *  count changed — so the storm collapses to "only the card whose stream advanced". */
function ColumnImpl({
  title,
  tasks,
  dotColor,
  clearable,
  selectedId,
  blockedIds,
  dependencyChipsById = NO_DEP_CHIPS,
  promptIds,
  logCounts,
  dropStatus,
  emptyText = 'Nothing here yet',
  onClear,
}: ColumnProps) {
  const showClear = clearable === true && tasks.length > 0;
  // Interactivity tracks the drop wiring: the board passes `dropStatus` exactly
  // when it owns a live DnD context, so eligible cards drag only where a drop
  // could resolve. Presentational stories omit it → non-draggable cards.
  const interactive = dropStatus !== undefined;
  const { setDropRef, setScrollRef, isOver, droppable, virtualizer } = useColumn(dropStatus, tasks);
  return (
    <div
      ref={setDropRef}
      className={`nc-board-column flex shrink-0 flex-col rounded-[13px] border bg-white/[0.015] transition-colors ${
        isOver ? 'border-primary/60 bg-primary/[0.04]' : 'border-border'
      }`}
      style={{ width: title === 'Failed' ? 248 : 296 }}
      aria-dropeffect={droppable ? 'move' : 'none'}
    >
      <div className="flex items-center gap-2 px-3.5 pb-3 pt-3.5">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: dotColor, boxShadow: `0 0 8px ${dotColor}` }}
        />
        <h2 className="text-xs-plus2 font-semibold">{title}</h2>
        <span className="rounded-md bg-white/[0.05] px-1.5 py-px font-mono text-2xs tabular-nums text-muted-foreground">
          {tasks.length}
        </span>
        {showClear && (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
          >
            <TrashIcon size={13} />
            Clear
          </button>
        )}
      </div>
      <div ref={setScrollRef} className="flex-1 overflow-auto px-3 pb-3">
        {tasks.length === 0 ? (
          // A string placeholder gets the dashed-text chrome; a node (the Backlog
          // "Add a task" ghost button the board supplies) renders as-is.
          typeof emptyText === 'string' ? (
            <p className="rounded-[11px] border border-dashed border-border px-3.5 py-6 text-center text-xs text-muted-foreground">
              {emptyText}
            </p>
          ) : (
            emptyText
          )
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const task = tasks[row.index];
              if (task === undefined) return null;
              return (
                <div
                  key={task.id}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full pb-2.5"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <TaskCard
                    task={task}
                    selected={task.id === selectedId}
                    blocked={blockedIds.has(task.id)}
                    blockedBy={dependencyChipsById.get(task.id)}
                    needsApproval={promptIds?.has(task.id) ?? false}
                    logCount={logCounts[task.id] ?? 0}
                    draggable={interactive && canDragStatus(task.status)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export const Column = memo(ColumnImpl);
