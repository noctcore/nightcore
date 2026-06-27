import { memo } from 'react';
import { DndContext, DragOverlay, closestCorners } from '@dnd-kit/core';
import { TaskCard } from '../TaskCard';
import { useBoardDnd } from './BoardDnd.hooks';
import type { BoardDndProps } from './BoardDnd.types';

/** Inert select for the non-interactive drag-overlay preview. */
const NOOP = (): void => {};

/** Drag-and-drop context for the board's columns. Wraps the columns row in a
 *  @dnd-kit `<DndContext>` — a pointer sensor with a 6px activation threshold (so
 *  card selection and the per-status action buttons still click through) plus a
 *  keyboard sensor for the accessible move path that replaces the old move menu.
 *
 *  A `<DragOverlay>` renders a clone of the dragged card (under a distinct
 *  draggable id via `preview`), so the drag stays smooth and visible even when
 *  column virtualization unmounts the source row on scroll. A drop on a different,
 *  droppable column resolves to `onMoveTask(id, status)`; everything else no-ops.
 *
 *  Presentation only — it owns no DOM of its own (the context adds no wrapper),
 *  so the columns row keeps its exact layout. */
function BoardDndImpl({ tasks, onMoveTask, children }: BoardDndProps) {
  const { sensors, activeTask, onDragStart, onDragEnd, onDragCancel } = useBoardDnd(
    tasks,
    onMoveTask,
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {children}
      <DragOverlay>
        {activeTask !== null ? (
          <TaskCard task={activeTask} selected={false} preview onSelect={NOOP} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export const BoardDnd = memo(BoardDndImpl);
