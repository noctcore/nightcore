import { useDroppable } from '@dnd-kit/core';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { useCallback, useId, useRef } from 'react';

import type { Task, TaskStatus } from '@/lib/bridge';

import { isDroppableStatus } from '../status';

/** Estimated card height (px) before measurement. Cards are variable-height
 *  (title + optional description + chips + actions); `measureElement` corrects
 *  each row to its real size once mounted. */
const ESTIMATED_CARD_HEIGHT = 140;

/** Extra rows rendered above/below the viewport so a fast scroll never flashes
 *  blank — and so a card mid-drag stays mounted a little past the fold. */
const OVERSCAN = 6;

export interface ColumnView {
  /** Ref for the column shell — the @dnd-kit drop target. */
  setDropRef: (element: HTMLElement | null) => void;
  /** Ref for the inner scroll container — the virtualizer's scroll element. */
  setScrollRef: (element: HTMLDivElement | null) => void;
  /** True while a dragged card hovers this (droppable) column — drives the glow. */
  isOver: boolean;
  /** Whether this column accepts drops (In Progress never does). */
  droppable: boolean;
  /** The vertical virtualizer for this column's card list. */
  virtualizer: Virtualizer<HTMLDivElement, Element>;
}

/** Column behavior: a whole-column @dnd-kit drop target (In Progress is inert —
 *  the backend rejects manual moves into a live run) plus a vertical virtualizer
 *  so a 50+ card column only mounts the visible rows. The drop target is the
 *  outer shell and the scroll element is the inner list, so they take separate
 *  refs (no ref merging). Cross-column moves resolve at the board's `onDragEnd`;
 *  the column only surfaces the hover glow + drop affordance. */
export function useColumn(dropStatus: TaskStatus | undefined, tasks: Task[]): ColumnView {
  const droppable = dropStatus !== undefined && isDroppableStatus(dropStatus);
  // A presentational column without a status still needs a unique droppable id so
  // two such columns never collide; fall back to a stable generated id.
  const fallbackId = useId();
  const { setNodeRef, isOver } = useDroppable({
    id: dropStatus ?? fallbackId,
    disabled: !droppable,
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
  }, []);

  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_CARD_HEIGHT,
    overscan: OVERSCAN,
    // Stable, unique keys are a hard requirement for correct reconciliation under
    // reorder (drag-and-drop) + virtualization: an unstable key lets React/TanStack
    // reuse the wrong DOM node and component state for a row. `Task.id` is a
    // non-optional string by contract and `count` is synced to `tasks.length`, so
    // this never fires — but assert the invariant loudly rather than silently
    // substituting a numeric index that would map to different tasks across reorders.
    getItemKey: (index) => {
      const id = tasks[index]?.id;
      if (id === undefined) {
        throw new Error(`Column virtualizer: task at index ${index} has no id (count=${tasks.length})`);
      }
      return id;
    },
  });

  return {
    setDropRef: setNodeRef,
    setScrollRef,
    isOver: isOver && droppable,
    droppable,
    virtualizer,
  };
}
