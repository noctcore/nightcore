/**
 * View-mode + pane-order persistence for the Terminal cockpit (decision 1, PR 2).
 * The grid/tabs choice and the pane ordering are a UI PREFERENCE, not session
 * state, so they live in a web-side localStorage blob (`nc:terminal:layout`) — no
 * Rust round-trip (spec § PR2d). Order self-prunes to the live session set (new
 * sessions append, closed ones drop); ZOOM is view-local and deliberately NOT
 * persisted (spec § PR2c + decision record § 1 persist only mode + order).
 *
 * Pure helpers (readLayout / writeLayout / orderSessions / reorderByDrop) are
 * exported for unit tests; `useTerminalLayout` owns the React-facing state plus the
 * session-manager visible-set + the ⌘⇧E zoom-shortcut wiring.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TerminalSessionInfo } from '@/lib/bridge';

import { clearActivity, setVisibleTerminals } from './terminal-attention';
import {
  isBroadcastEligible,
  setBroadcastArmed as syncBroadcastArmed,
} from './terminal-broadcast';

/** The terminal body layout: a tabbed single pane or a count-driven grid. */
export type TerminalViewMode = 'tabs' | 'grid';

/** The persisted layout blob shape (additive — unknown keys tolerated, missing keys
 *  default). */
export interface TerminalLayout {
  readonly mode: TerminalViewMode;
  readonly order: readonly string[];
}

/** localStorage key for the layout blob (web-side preference, not session state). */
export const TERMINAL_LAYOUT_KEY = 'nc:terminal:layout';

const DEFAULT_LAYOUT: TerminalLayout = { mode: 'tabs', order: [] };

/** Read the persisted layout, tolerant of a missing/corrupt/blocked store or a
 *  partial blob (an older/newer app writing a subset). Defaults to tabs + no order. */
export function readLayout(): TerminalLayout {
  try {
    const raw = window.localStorage.getItem(TERMINAL_LAYOUT_KEY);
    if (raw === null) return DEFAULT_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LAYOUT;
    const record = parsed as Record<string, unknown>;
    const mode: TerminalViewMode = record.mode === 'grid' ? 'grid' : 'tabs';
    const order = Array.isArray(record.order)
      ? record.order.filter((id): id is string => typeof id === 'string')
      : [];
    return { mode, order };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** Persist the layout blob (best-effort; private-mode / storage-disabled failures
 *  are swallowed — the layout just won't survive a restart). */
export function writeLayout(layout: TerminalLayout): void {
  try {
    window.localStorage.setItem(TERMINAL_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* storage disabled — layout won't persist. */
  }
}

/** Apply a persisted id order to the live session list: knowns first in persisted
 *  order, then any unknown (new) session appended in its arrival order. A session
 *  whose id is absent from `sessions` drops out (a closed shell). Pure + stable. */
export function orderSessions(
  sessions: readonly TerminalSessionInfo[],
  order: readonly string[],
): TerminalSessionInfo[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const ordered: TerminalSessionInfo[] = [];
  for (const id of order) {
    const session = byId.get(id);
    if (session !== undefined && !seen.has(id)) {
      ordered.push(session);
      seen.add(id);
    }
  }
  for (const session of sessions) {
    if (!seen.has(session.id)) ordered.push(session);
  }
  return ordered;
}

/** Move `activeId` into `overId`'s slot in the order (drag-reorder resolution). Pure
 *  + exported so the DnD move is unit-testable WITHOUT a real pointer drag (flaky in
 *  the browser runner) — mirrors the board's `resolveDrop` idiom. Returns a copy
 *  unchanged when the ids match or either is absent. */
export function reorderByDrop(
  order: readonly string[],
  activeId: string,
  overId: string,
): string[] {
  if (activeId === overId) return [...order];
  const from = order.indexOf(activeId);
  const to = order.indexOf(overId);
  if (from === -1 || to === -1) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

/** Whether two id lists are identical (same length + order). */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
}

/** Input to {@link useTerminalLayout}: the live sessions, the active tab id (the
 *  ⌘⇧E zoom target + the tabs-mode visible pane), and whether the initial session
 *  list has loaded (so the reconcile never prunes the persisted order during the
 *  async load gap — see the reconcile effect). */
interface UseTerminalLayoutInput {
  readonly sessions: readonly TerminalSessionInfo[];
  readonly activeId: string | null;
  readonly loaded: boolean;
}

/** The layout state exposed to the Terminal view. */
export interface TerminalLayoutState {
  readonly mode: TerminalViewMode;
  readonly orderedSessions: TerminalSessionInfo[];
  readonly zoomedId: string | null;
  readonly toggleMode: () => void;
  readonly reorder: (activeId: string, overId: string) => void;
  readonly toggleZoom: (id: string) => void;
  /** Whether broadcast input is armed (round-2 PR B): typing in the focused pane fans
   *  out to every visible pane. Grid-only; auto-disarms off-grid / on zoom / on collapse. */
  readonly broadcastArmed: boolean;
  /** Whether broadcast CAN be armed right now (grid view with 2+ visible panes). Gates
   *  the toggle's enabled state + the auto-disarm. */
  readonly broadcastEligible: boolean;
  /** Arm/disarm broadcast (no-op arm when ineligible). */
  readonly toggleBroadcast: () => void;
}

export function useTerminalLayout({
  sessions,
  activeId,
  loaded,
}: UseTerminalLayoutInput): TerminalLayoutState {
  const initial = useMemo(() => readLayout(), []);
  const [mode, setMode] = useState<TerminalViewMode>(initial.mode);
  const [order, setOrder] = useState<string[]>([...initial.order]);
  const [zoomedId, setZoomedId] = useState<string | null>(null);
  // Broadcast-input arm state (round-2 PR B): view-local (like zoom), never persisted —
  // a footgun must never survive a restart armed.
  const [broadcastArmed, setBroadcastArmed] = useState(false);
  const orderedSessions = useMemo(() => orderSessions(sessions, order), [sessions, order]);

  // Latest active id + ordered list, read by the ⌘⇧E handler without re-binding the
  // window listener every time the active tab or session set changes.
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const orderedRef = useRef(orderedSessions);
  orderedRef.current = orderedSessions;

  // Reconcile `order` to the live set (append new, drop closed) so the persisted
  // list self-prunes. GATED on `loaded`: before the first `listTerminals()` resolves
  // `sessions` is empty, and pruning then would wipe the persisted order (losing pane
  // order on every nav-away/back). Guarded to settle — once order === live ids,
  // `orderSessions` is idempotent and this no-ops.
  useEffect(() => {
    if (!loaded) return;
    const liveIds = orderedSessions.map((s) => s.id);
    setOrder((prev) => (sameIds(prev, liveIds) ? prev : liveIds));
  }, [loaded, orderedSessions]);

  // Persist mode + order (web-side preference; zoom stays view-local). Safe before
  // `loaded` because `order` is untouched until the gated reconcile above runs.
  useEffect(() => {
    writeLayout({ mode, order });
  }, [mode, order]);

  // A zoom target whose shell closed clears back to the full grid.
  useEffect(() => {
    if (zoomedId !== null && !sessions.some((s) => s.id === zoomedId)) setZoomedId(null);
  }, [sessions, zoomedId]);

  const toggleMode = useCallback(() => setMode((m) => (m === 'grid' ? 'tabs' : 'grid')), []);
  const reorder = useCallback((active: string, over: string) => {
    setOrder((prev) => reorderByDrop(prev, active, over));
  }, []);
  const toggleZoom = useCallback((id: string) => {
    setZoomedId((cur) => (cur === id ? null : id));
  }, []);

  // The visible set the session manager uses to gate unread badges: grid → every
  // mounted pane (or just the zoomed one); tabs → the active pane only. Zoomed-away
  // grid panes stay off the set, so they keep badging (decision 6c / § PR2c).
  const visibleIds = useMemo(() => {
    if (mode === 'grid' && orderedSessions.length > 0) {
      if (zoomedId !== null) return [zoomedId];
      return orderedSessions.map((s) => s.id);
    }
    return activeId === null ? [] : [activeId];
  }, [mode, orderedSessions, zoomedId, activeId]);

  useEffect(() => {
    setVisibleTerminals(visibleIds);
  }, [visibleIds]);

  // Broadcast input (round-2 PR B). Eligible only in grid view with 2+ visible panes;
  // `visibleIds` already encodes grid + non-zoomed (tabs → 1, zoomed → 1), so this turns
  // false the instant the user leaves grid, zooms a pane, or closes down to one pane.
  const broadcastEligible = isBroadcastEligible(mode === 'grid', visibleIds.length);
  // Auto-disarm the moment broadcast stops being eligible — a LOUD footgun must never
  // linger armed off-grid (decision B / § B.1).
  useEffect(() => {
    if (broadcastArmed && !broadcastEligible) setBroadcastArmed(false);
  }, [broadcastArmed, broadcastEligible]);
  // Mirror the armed flag into the module-level fan-out (read by the session manager's
  // input path + the keymap emits). The cleanup disarms on unmount (nav away from the
  // Terminal view) so the module never stays armed with no view to show the indicator.
  useEffect(() => {
    syncBroadcastArmed(broadcastArmed);
    return () => syncBroadcastArmed(false);
  }, [broadcastArmed]);
  const toggleBroadcast = useCallback(() => {
    // Toggling OFF always works; toggling ON only when eligible (2+ visible grid panes).
    setBroadcastArmed((on) => (on ? false : broadcastEligible));
  }, [broadcastEligible]);

  // Regaining window focus clears unread for every currently-visible pane (the user
  // is looking at them again), mirroring the activation clear.
  useEffect(() => {
    const onFocus = () => {
      for (const id of visibleIds) clearActivity(id);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [visibleIds]);

  // ⌘/⌃⇧E toggles zoom of the active pane while in grid mode (decision 1 / § PR2c).
  // Modifier-gated, so it never collides with the bare-letter nav shortcuts or with
  // typing in a terminal (trap m); scoped to this view (the hook only lives while the
  // Terminal view is mounted).
  useEffect(() => {
    if (mode !== 'grid') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        setZoomedId((cur) =>
          cur !== null ? null : (activeRef.current ?? orderedRef.current[0]?.id ?? null),
        );
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode]);

  return {
    mode,
    orderedSessions,
    zoomedId,
    toggleMode,
    reorder,
    toggleZoom,
    broadcastArmed,
    broadcastEligible,
    toggleBroadcast,
  };
}
