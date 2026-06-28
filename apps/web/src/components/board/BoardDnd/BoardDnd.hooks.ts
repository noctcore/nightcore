/** Drag-and-drop state, sensors, and drop resolution for the board's columns. */
import { useCallback, useMemo, useState } from 'react';
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { Task, TaskStatus } from '@/lib/bridge';
import { COLUMNS, canDragStatus, isDroppableStatus } from '../status';

/** A pointer drag only begins after this much movement (px) — below it the press
 *  is a click, so selecting a card or tapping its action buttons never starts a
 *  drag. This is what lets the whole card double as the drag handle. */
const ACTIVATION_DISTANCE = 6;

/** A resolved drag-end move: the card id and the destination status. */
export interface DropResolution {
  id: string;
  status: TaskStatus;
}

/** Resolve a drag-end into a status move, or `null` for a no-op. A move fires only
 *  when a card is dropped over a droppable column that does NOT already hold the
 *  card's status. No-ops: a drop outside any column, an unknown card id, a pinned
 *  (running/verifying) card, a drop onto an inert column (In Progress / Verifying),
 *  and a drop back onto the card's OWN column. The own-column check is column-aware,
 *  not primary-status-aware: the Backlog column groups `backlog`+`ready` under one
 *  droppable (its primary status `backlog`), so a `ready` card dropped back on
 *  Backlog must be a no-op — never a silent demotion to `backlog`. Pure + exported
 *  so the board's move wiring is unit-testable without a real pointer drag (which is
 *  flaky in the browser runner). */
export function resolveDrop(
  activeId: string,
  overStatus: string | null,
  tasks: Task[],
): DropResolution | null {
  if (overStatus === null) return null;
  const task = tasks.find((candidate) => candidate.id === activeId);
  if (task === undefined) return null;
  if (!canDragStatus(task.status)) return null;
  if (!isDroppableStatus(overStatus as TaskStatus)) return null;
  // No-op when the destination column already contains the card's current status
  // (its own column), resolving the droppable id back to its grouping column.
  const destColumn = COLUMNS.find((column) => column.statuses[0] === overStatus);
  if (destColumn !== undefined && destColumn.statuses.includes(task.status)) return null;
  return { id: activeId, status: overStatus as TaskStatus };
}

/** The drag state and handlers returned by {@link useBoardDnd}. */
export interface BoardDndState {
  sensors: ReturnType<typeof useSensors>;
  /** The task being dragged, for the `<DragOverlay>` preview (`null` when idle). */
  activeTask: Task | null;
  onDragStart: (event: DragStartEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragCancel: () => void;
}

/** Board-level drag state + sensors. Pointer drags clear a 6px threshold (so
 *  clicks survive) and a keyboard sensor provides the accessible move path. The
 *  active task id is tracked so the overlay can render a live preview; a drop is
 *  resolved against the task list and relayed to `onMoveTask`. */
export function useBoardDnd(
  tasks: Task[],
  onMoveTask: (id: string, status: TaskStatus) => void,
): BoardDndState {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: ACTIVATION_DISTANCE } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const over = event.over;
      const resolution = resolveDrop(
        String(event.active.id),
        over === null ? null : String(over.id),
        tasks,
      );
      if (resolution !== null) onMoveTask(resolution.id, resolution.status);
    },
    [tasks, onMoveTask],
  );

  const onDragCancel = useCallback(() => setActiveId(null), []);

  const activeTask = useMemo(
    () => (activeId === null ? null : (tasks.find((task) => task.id === activeId) ?? null)),
    [activeId, tasks],
  );

  return { sensors, activeTask, onDragStart, onDragEnd, onDragCancel };
}
