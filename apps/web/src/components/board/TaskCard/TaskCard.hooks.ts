/** TaskCard hooks: the live elapsed-time ticker and the @dnd-kit draggable
 *  wiring (with button-safe drag ARIA). */
import type { DraggableSyntheticListeners } from '@dnd-kit/core';
import { useDraggable } from '@dnd-kit/core';
import { useEffect, useState } from 'react';

import type { Task } from '@/lib/bridge';
import { formatElapsed as formatElapsedShared } from '@/lib/formatters';

import type { DependencyChip } from '../Board/Board.utils';
import { canRunTask, type RunGate, useRunGate } from '../run-gating';
import { modelBadge } from '../status';

/** The human-readable blocked chip (T13): a short label + full tooltip naming the
 *  UNFINISHED dependencies by title (id → title resolved upstream). Replaces the raw
 *  `blocked · 3f2a9c…` id display. Pure. */
export function blockedDepChip(blockedBy: DependencyChip[] | undefined): {
  label: string;
  tooltip: string;
} {
  const unmet = (blockedBy ?? []).filter((dep) => !dep.satisfied);
  if (unmet.length === 0) {
    return { label: 'blocked', tooltip: 'Waiting on an unfinished dependency' };
  }
  const names = unmet.map((dep) => dep.title ?? 'a deleted task');
  const label =
    unmet.length === 1 ? `blocked · ${unmet[0]!.title ?? 'deleted task'}` : `blocked · ${unmet.length} deps`;
  return { label, tooltip: `Waiting on: ${names.join(', ')}` };
}

/** The card's derived presentational view (T13): the honest model badge, the shared
 *  slot-aware run gate (reads the board-wide `RunGate` context), the human-readable
 *  blocked chip, and the settled-state chip visibility + attention pulse. Groups the
 *  pure derivations so the card body stays lean. */
export function useTaskCardView(
  task: Task,
  blocked: boolean,
  blockedBy: DependencyChip[] | undefined,
  needsApproval: boolean,
): {
  badge: { label: string; dotColor: string };
  gate: RunGate;
  depChip: { label: string; tooltip: string };
  /** Show the branch chip: a worktree task's branch, once the run has settled. */
  showBranch: boolean;
  /** Show the "main" chip: a main-mode task edits the tree in place (no branch). */
  showMainChip: boolean;
  /** The attention ring: a needs-approval pulse, else a verifying pulse, else none. */
  pulse: string;
} {
  const { slotsFree } = useRunGate();
  const verifying = task.status === 'verifying';
  const settled =
    task.status === 'in_progress' ||
    verifying ||
    task.status === 'waiting_approval' ||
    task.status === 'done' ||
    task.status === 'failed';
  return {
    badge: modelBadge(task),
    gate: canRunTask({ blocked, slotsFree }),
    depChip: blockedDepChip(blockedBy),
    showBranch: task.branch !== null && settled,
    showMainChip: task.runMode === 'main' && settled,
    pulse: needsApproval
      ? 'animate-pulse ring-1 ring-warning/60'
      : verifying
        ? 'animate-pulse ring-1 ring-primary/50'
        : '',
  };
}

/** Format a millisecond elapsed span as mm:ss (zero-padded minutes). Delegates
 *  to the shared `lib/formatters` helper; the board's live cards pad minutes. */
export function formatElapsed(ms: number): string {
  return formatElapsedShared(ms, { padMinutes: true });
}

/** Module-level 1Hz ticker shared by every live card. N running cards subscribe to
 *  ONE interval (not N), and the interval runs only while at least one subscriber is
 *  active — so an idle board schedules no timer at all. Each subscriber is notified
 *  on the tick; the returned unsubscribe tears the interval down once the last card
 *  detaches. Exported for the colocated deterministic ticker test. */
const tickSubscribers = new Set<() => void>();
let tickHandle: ReturnType<typeof setInterval> | null = null;

export function subscribeSecondTick(onTick: () => void): () => void {
  tickSubscribers.add(onTick);
  if (tickHandle === null) {
    tickHandle = setInterval(() => {
      for (const fn of tickSubscribers) fn();
    }, 1000);
  }
  return () => {
    tickSubscribers.delete(onTick);
    if (tickSubscribers.size === 0 && tickHandle !== null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  };
}

/** A live mm:ss elapsed timer counting up from `since`, ticking once a second
 *  while `active`. Used by the running card and the detail drawer header.
 *
 *  `since` is deliberately NOT in the effect deps: it is the task's `updatedAt`,
 *  bumped repeatedly as the stream flushes, so keying the effect on it would tear
 *  down and rebuild the ticker on every delta (and fire an extra immediate tick).
 *  The effect only needs to (re)subscribe when `active` flips; `since` is read on
 *  each render in the returned `formatElapsed(now - since)`, so the displayed value
 *  still tracks the latest `since` without churning the interval. */
export function useElapsed(since: number, active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return subscribeSecondTick(() => setNow(Date.now()));
  }, [active]);
  return formatElapsed(now - since);
}

/** The keyboard/SR drag attributes we spread onto the card root — dnd-kit's
 *  `DraggableAttributes` MINUS `role`/`aria-pressed`. The card root holds real
 *  `<button>`s (open, run, commit…), so exposing it as `role="button"` would nest
 *  interactive controls inside a button — invalid ARIA. We keep `tabIndex` +
 *  `aria-roledescription` + `aria-describedby` so the card stays keyboard-draggable
 *  with dnd-kit's screen-reader instructions, just not announced as a button. */
export interface TaskDragAttributes {
  tabIndex: number;
  'aria-roledescription': string;
  'aria-describedby': string;
}

export interface TaskDraggable {
  /** Ref for the draggable card root. */
  setNodeRef: (element: HTMLElement | null) => void;
  /** Pointer/keyboard activator listeners — spread onto the card root when the
   *  card is draggable (omitted for pinned cards). */
  listeners: DraggableSyntheticListeners;
  /** Focus + SR attributes that make the card keyboard-draggable, WITHOUT the
   *  button-specific ARIA (see {@link TaskDragAttributes}). */
  attributes: TaskDragAttributes;
  /** True while THIS card is the active drag source (dimmed; the overlay shows
   *  the live preview). */
  isDragging: boolean;
}

/** @dnd-kit draggable wiring for a task card. `enabled` reflects the board's
 *  pin rule (running/verifying cards aren't draggable). When `preview` is set the
 *  card is the `<DragOverlay>` clone, so it registers under a distinct id — the
 *  live source keeps its own @dnd-kit registration intact across the drag. Safe
 *  to call outside a `<DndContext>` (presentational stories) — it returns inert
 *  refs rather than throwing. */
export function useTaskDraggable(id: string, enabled: boolean, preview: boolean): TaskDraggable {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: preview ? `overlay:${id}` : id,
    disabled: !enabled,
  });
  // Pick only the non-button activator attributes — the card root must not carry
  // `role="button"`/`aria-pressed` (it contains real buttons). Keyboard drag still
  // works: the root stays focusable (tabIndex) and dnd-kit's keydown activator lives
  // in `listeners`, with its instructions wired via `aria-describedby`.
  return {
    setNodeRef,
    listeners,
    attributes: {
      tabIndex: attributes.tabIndex,
      'aria-roledescription': attributes['aria-roledescription'],
      'aria-describedby': attributes['aria-describedby'],
    },
    isDragging,
  };
}
