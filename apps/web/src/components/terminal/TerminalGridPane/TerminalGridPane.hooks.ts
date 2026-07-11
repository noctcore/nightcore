/** TerminalGridPane state/effects: the shared xterm attach plus the @dnd-kit
 *  draggable (grip) + droppable (whole pane) wiring for reorder. The `.tsx` stays a
 *  thin shell — no hooks in the component body. */
import type { DraggableSyntheticListeners } from '@dnd-kit/core';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { type RefObject, useCallback } from 'react';

import { useTerminalAttach } from '../terminal-attach';
import { type TerminalSearch, useTerminalSearch } from '../terminal-search';

/** The focus + SR drag attributes spread onto the grip — dnd-kit's
 *  `DraggableAttributes` MINUS `role`/`aria-pressed`/`aria-disabled` (the grip is
 *  already a real `<button>`, so its implicit `role="button"` suffices and dnd-kit's
 *  loosely-typed `role: string` isn't spread onto the element). `tabIndex` +
 *  `aria-roledescription` + `aria-describedby` keep the grip keyboard-draggable with
 *  dnd-kit's screen-reader instructions — the board's `TaskDragAttributes` idiom. */
export interface GridPaneGripAttributes {
  readonly tabIndex: number;
  readonly 'aria-roledescription': string;
  readonly 'aria-describedby': string;
}

/** The refs + drag state a grid pane binds to. */
export interface TerminalGridPaneView {
  /** Ref for the xterm surface (the persistent host is moved into it on attach). */
  readonly containerRef: RefObject<HTMLDivElement | null>;
  /** Merged ref for the pane root — BOTH the draggable node (measured for the drag)
   *  and the droppable target (a drop over it reorders). */
  readonly setRootRef: (element: HTMLElement | null) => void;
  /** Pointer/keyboard drag activators — spread onto the GRIP handle only, so the
   *  xterm surface keeps its own pointer events (typing/selection). */
  readonly gripListeners: DraggableSyntheticListeners;
  /** Focus + SR drag attributes for the grip (keyboard-draggable). */
  readonly gripAttributes: GridPaneGripAttributes;
  /** True while THIS pane is the drag source (dimmed; the overlay shows a preview). */
  readonly isDragging: boolean;
  /** True while a dragged pane hovers this (droppable) pane — drives the drop glow. */
  readonly isOver: boolean;
  /** In-pane search state (⌘F find bar, spec PR 3c). */
  readonly search: TerminalSearch;
}

/** Attach the session's xterm and register the pane as a same-id draggable +
 *  droppable (dnd-kit keeps the two registries separate, so one id in both is the
 *  sanctioned sortable-item shape). Reorder is disabled while zoomed (`!draggable`).
 *  The drag TRANSFORM is intentionally NOT applied to the root — the live xterm must
 *  not move/scale mid-drag (a `<DragOverlay>` renders the moving preview instead). */
export function useTerminalGridPane(sessionId: string, draggable: boolean): TerminalGridPaneView {
  const { containerRef } = useTerminalAttach(sessionId);
  const search = useTerminalSearch(sessionId);
  const drag = useDraggable({ id: sessionId, disabled: !draggable });
  const drop = useDroppable({ id: sessionId, disabled: !draggable });

  const { setNodeRef: setDragRef } = drag;
  const { setNodeRef: setDropRef } = drop;
  const setRootRef = useCallback(
    (element: HTMLElement | null) => {
      setDragRef(element);
      setDropRef(element);
    },
    [setDragRef, setDropRef],
  );

  return {
    containerRef,
    setRootRef,
    gripListeners: drag.listeners,
    // Narrow to the button-safe subset (see {@link GridPaneGripAttributes}).
    gripAttributes: {
      tabIndex: drag.attributes.tabIndex,
      'aria-roledescription': drag.attributes['aria-roledescription'],
      'aria-describedby': drag.attributes['aria-describedby'],
    },
    isDragging: drag.isDragging,
    isOver: drop.isOver && draggable,
    search,
  };
}
