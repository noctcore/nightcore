/** TerminalGrid state: @dnd-kit reorder sensors + drop resolution, the drag-overlay
 *  preview source, and the RAF-retry refit that repaints panes after a reorder /
 *  zoom reflow. The `.tsx` stays a thin shell. */
import {
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TerminalSessionInfo } from '@/lib/bridge';

import { refitSession } from '../terminal-session-manager';

/** A pointer drag begins only after this much movement (px) — below it a press is a
 *  click, so the grip's press-and-hold still reads as a click on short taps and the
 *  title/zoom controls click through. */
const DRAG_ACTIVATION_DISTANCE = 8;

/**
 * RAF-retry refit for a set of panes. A grid cell that transiently collapsed to 0px
 * during a drag, or a pane whose cell just changed size on relayout/zoom, leaves a
 * blank/stale canvas that `fit()` alone (seeing no net dimension change) won't
 * repaint. Refitting on the NEXT frame, after the reflow settles, forces the repaint.
 * Returns a cancel so an effect can tear the pending frames down.
 */
function scheduleRefit(ids: readonly string[]): () => void {
  let raf2 = 0;
  const raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(() => {
      for (const id of ids) refitSession(id);
    });
  });
  return () => {
    cancelAnimationFrame(raf1);
    if (raf2 !== 0) cancelAnimationFrame(raf2);
  };
}

/** The grid's drag state + handlers. */
export interface TerminalGridState {
  readonly sensors: ReturnType<typeof useSensors>;
  /** The pane being dragged, for the `<DragOverlay>` preview (`null` when idle). */
  readonly activeSession: TerminalSessionInfo | null;
  readonly onDragStart: (event: DragStartEvent) => void;
  readonly onDragEnd: (event: DragEndEvent) => void;
  readonly onDragCancel: () => void;
}

interface UseTerminalGridInput {
  readonly sessions: TerminalSessionInfo[];
  readonly zoomedId: string | null;
  readonly onReorder: (activeId: string, overId: string) => void;
}

export function useTerminalGrid({
  sessions,
  zoomedId,
  onReorder,
}: UseTerminalGridInput): TerminalGridState {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);
  const onDragCancel = useCallback(() => setActiveId(null), []);
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const over = event.over;
      if (over !== null) {
        const active = String(event.active.id);
        const overId = String(over.id);
        if (active !== overId) onReorder(active, overId);
      }
      // Repaint every pane after the drop reflow settles (a collapsed/moved cell).
      scheduleRefit(sessions.map((s) => s.id));
    },
    [sessions, onReorder],
  );

  const activeSession = useMemo(
    () => (activeId === null ? null : (sessions.find((s) => s.id === activeId) ?? null)),
    [activeId, sessions],
  );

  // Refit the resized pane(s) after a zoom transition: zoom in → just the zoomed
  // pane; zoom out → every pane just remounted at grid size. Keyed on the zoom
  // transition ONLY — spawns/closes are handled by each pane's own resize observer.
  useEffect(() => {
    const ids = zoomedId !== null ? [zoomedId] : sessions.map((s) => s.id);
    return scheduleRefit(ids);
  }, [zoomedId]);

  return { sensors, activeSession, onDragStart, onDragEnd, onDragCancel };
}
