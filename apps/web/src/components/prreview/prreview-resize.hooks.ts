/** A persisted, keyboard-accessible resize model for the PR workspace's split —
 *  the draggable divider between the list rail and the review panel. The width
 *  survives reloads (localStorage), clamps to a sensible range, resets on
 *  double-click, and drives a `role="separator"` handle with arrow-key control.
 *  Pure DOM/pointer wiring; no bridge calls. This is the file's only hook. */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

const STORAGE_KEY = 'nc:prreview:list-width';
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const KEY_STEP = 24;

export interface ResizablePanelOptions {
  storageKey?: string;
  defaultWidth?: number;
  min?: number;
  max?: number;
  step?: number;
}

/** The ARIA + handler bundle spread onto the divider element. */
export interface SeparatorProps {
  role: 'separator';
  'aria-orientation': 'vertical';
  'aria-valuenow': number;
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-label': string;
  tabIndex: 0;
  onPointerDown: (event: ReactPointerEvent) => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  onDoubleClick: () => void;
}

export interface ResizablePanel {
  /** The current panel width in px (clamped). */
  width: number;
  /** True while a pointer drag is in progress (drives the resize cursor overlay
   *  + select-none on the shell). */
  dragging: boolean;
  /** Props for the `role="separator"` divider element. */
  separatorProps: SeparatorProps;
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Read the persisted width, clamped, or the default when absent/invalid/unreadable. */
function readStored(key: string, def: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return def;
    return clamp(Number(raw), min, max, def);
  } catch {
    return def;
  }
}

/** Drive the resizable list rail: a persisted, clamped width with a draggable +
 *  keyboard-accessible divider and a double-click reset to the default. */
export function useResizablePanelWidth(options: ResizablePanelOptions = {}): ResizablePanel {
  const {
    storageKey = STORAGE_KEY,
    defaultWidth = DEFAULT_WIDTH,
    min = MIN_WIDTH,
    max = MAX_WIDTH,
    step = KEY_STEP,
  } = options;

  const [width, setWidth] = useState(() => readStored(storageKey, defaultWidth, min, max));
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  // Persist every settled width so a reload restores the user's split.
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      /* private mode / disabled storage — width just won't persist. */
    }
  }, [storageKey, width]);

  // Track the drag on the window so it continues even when the pointer outruns
  // the thin handle. Cleaned up the instant the drag ends.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const s = dragState.current;
      if (s === null) return;
      setWidth(clamp(s.startWidth + (e.clientX - s.startX), min, max, defaultWidth));
    };
    const onUp = () => {
      setDragging(false);
      dragState.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, min, max, defaultWidth]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return; // primary button only
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: width };
      setDragging(true);
    },
    [width],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          setWidth((w) => clamp(w - step, min, max, defaultWidth));
          break;
        case 'ArrowRight':
          e.preventDefault();
          setWidth((w) => clamp(w + step, min, max, defaultWidth));
          break;
        case 'Home':
          e.preventDefault();
          setWidth(min);
          break;
        case 'End':
          e.preventDefault();
          setWidth(max);
          break;
      }
    },
    [step, min, max, defaultWidth],
  );

  const reset = useCallback(() => setWidth(defaultWidth), [defaultWidth]);

  return {
    width,
    dragging,
    separatorProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
      'aria-label': 'Resize the pull-request list',
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
      onDoubleClick: reset,
    },
  };
}
