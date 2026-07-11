/**
 * Terminal attention state — the 3-state activity model for tabs/panes (T11).
 *
 * Split out of the session manager (which was at the file-size cap) so the
 * module-level activity counters live in one place, and extended from the old
 * generic byte-count "unread" badge into three states:
 *
 *   - **idle** — nothing to show.
 *   - **has-output** — bytes arrived while the pane was off-screen (`unread > 0`).
 *     Generic byte-activity, NEVER Claude-output content parsing.
 *   - **needs-attention** — a *completion/awaiting* signal (an OSC 9/99/777 or a
 *     BEL emitted by the shell) fired while the pane was off-screen. The LOUD
 *     state: the tab is asking for the user.
 *
 * `needs-attention` outranks `has-output`. Both clear the instant the pane becomes
 * visible or the window regains focus (the user is looking at it again).
 *
 * WHY MODULE-LEVEL (not React): the session manager's xterm instances survive the
 * routed view's remounts (they live outside the tree), so their activity counters
 * must too. A tiny subscription bridges these counters into the React badge hook.
 *
 * The `needs-attention` signal is fed OUTPUT-SIDE ONLY — by parsing the standard
 * OSC/BEL escape sequences the shell already emits ({@link installCompletionSignals}).
 * It never reaches into the PTY, so the terminal's USER-ONLY seam is preserved, and
 * it deliberately avoids the rejected busy/idle output-content regex heuristics.
 */
import type { IDisposable, Terminal } from '@xterm/xterm';
import { useEffect, useMemo, useState } from 'react';

import type { TerminalSessionInfo } from '@/lib/bridge';

/** A session's live attention state. `needsAttention` outranks `unread` for the
 *  badge; both clear when the pane becomes visible. */
export interface TerminalAttention {
  /** Off-screen output batches (the has-output signal). Clamped for display only. */
  readonly unread: number;
  /** A completion/awaiting signal (OSC 9/99/777 or BEL) fired while off-screen. */
  readonly needsAttention: boolean;
}

/** The three attention levels a tab/pane badge renders. */
export type TerminalAttentionLevel = 'idle' | 'has-output' | 'needs-attention';

/** The default (nothing pending) state — shared so callers don't re-literal it. */
export const IDLE_ATTENTION: TerminalAttention = { unread: 0, needsAttention: false };

/** Derive the badge level from a session's attention state (needs-attention wins). */
export function attentionLevel(a: TerminalAttention | undefined): TerminalAttentionLevel {
  if (a === undefined) return 'idle';
  if (a.needsAttention) return 'needs-attention';
  return a.unread > 0 ? 'has-output' : 'idle';
}

interface MutableAttention {
  unread: number;
  needsAttention: boolean;
}

const state = new Map<string, MutableAttention>();

/** The session ids currently visible on screen — output/attention for a visible id
 *  never accrues, and its badge clears immediately. In tabs mode this is the single
 *  active tab; in grid mode every mounted pane (or just the zoomed one). */
let visibleIds: Set<string> = new Set();

type ActivityListener = () => void;
const activityListeners = new Set<ActivityListener>();

function notifyActivity(): void {
  for (const fn of activityListeners) fn();
}

/** Completion-signal listeners (T11): every OSC/BEL completion fires these with the
 *  session id, REGARDLESS of visibility — the desktop-notification layer decides
 *  whether to notify (unfocused/off-screen + setting). Kept separate from the
 *  attention state (which gates on visibility) so the two consumers stay independent. */
type CompletionListener = (id: string) => void;
const completionListeners = new Set<CompletionListener>();

/** Subscribe to raw completion signals (an OSC 9/99/777 or a BEL). Returns an
 *  unsubscribe. Used by the desktop-notification layer; the attention badge consumes
 *  the same signal through {@link recordAttention} inside {@link installCompletionSignals}. */
export function subscribeCompletion(fn: CompletionListener): () => void {
  completionListeners.add(fn);
  return () => {
    completionListeners.delete(fn);
  };
}

function emitCompletion(id: string): void {
  for (const fn of completionListeners) fn(id);
}

function getOrCreate(id: string): MutableAttention {
  let entry = state.get(id);
  if (entry === undefined) {
    entry = { unread: 0, needsAttention: false };
    state.set(id, entry);
  }
  return entry;
}

/** The ids currently visible — read by the session manager's broadcast write path. */
export function getVisibleIds(): ReadonlySet<string> {
  return visibleIds;
}

/** Record one output batch for `id`: bump its unread badge + notify, unless it is
 *  currently visible (which never accrues). Generic byte-activity only. */
export function recordActivity(id: string): void {
  if (visibleIds.has(id)) return;
  getOrCreate(id).unread += 1;
  notifyActivity();
}

/** Record a completion/awaiting signal for `id` (an OSC 9/99/777 or a BEL fired
 *  while off-screen) — set its needs-attention state, unless it is currently visible
 *  (the user already sees it). Returns whether the state actually flipped ON, so a
 *  caller (the desktop-notification hook) can fire exactly once per fresh signal. */
export function recordAttention(id: string): boolean {
  if (visibleIds.has(id)) return false;
  const entry = getOrCreate(id);
  if (entry.needsAttention) {
    notifyActivity();
    return false;
  }
  entry.needsAttention = true;
  notifyActivity();
  return true;
}

/** Subscribe to any activity/attention change. Returns an unsubscribe. */
export function subscribeActivity(fn: ActivityListener): () => void {
  activityListeners.add(fn);
  return () => {
    activityListeners.delete(fn);
  };
}

/** The current attention state for a session (idle for unknown/visible ids). */
export function getAttention(id: string): TerminalAttention {
  const entry = state.get(id);
  if (entry === undefined) return IDLE_ATTENTION;
  return { unread: entry.unread, needsAttention: entry.needsAttention };
}

/** The current unread-output count for a session (0 for unknown/visible ids). */
export function getUnread(id: string): number {
  return state.get(id)?.unread ?? 0;
}

/** Clear a session's activity + attention (focus regain / activation). Notifies only
 *  when something actually changed, so a no-op clear doesn't churn subscribers. */
export function clearActivity(id: string): void {
  const entry = state.get(id);
  if (entry === undefined || (entry.unread === 0 && !entry.needsAttention)) return;
  entry.unread = 0;
  entry.needsAttention = false;
  notifyActivity();
}

/** Mark the set of currently-visible sessions: each stops accruing and its badge
 *  clears immediately; every other session keeps signalling its background activity. */
export function setVisibleTerminals(ids: readonly string[]): void {
  visibleIds = new Set(ids);
  for (const id of ids) clearActivity(id);
}

/** Mark `id` the single visible/active session (tabs mode). `null` leaves every
 *  session eligible to signal. A thin wrapper over {@link setVisibleTerminals}. */
export function setActiveTerminal(id: string | null): void {
  setVisibleTerminals(id === null ? [] : [id]);
}

/** Drop a session's attention state (on close). Idempotent. */
export function forgetAttention(id: string): void {
  if (state.delete(id)) notifyActivity();
}

/** The next session id (cyclically after `currentId`, else the first) whose state is
 *  needs-attention — the "jump to next waiting terminal" target. Pure so the jump is
 *  unit-testable without live module state. `null` when nothing is waiting. */
export function nextAttentionId(
  orderedIds: readonly string[],
  currentId: string | null,
  attention: Readonly<Record<string, TerminalAttention>>,
): string | null {
  const waiting = (id: string): boolean => attention[id]?.needsAttention === true;
  const start = currentId === null ? -1 : orderedIds.indexOf(currentId);
  for (let i = 1; i <= orderedIds.length; i += 1) {
    const id = orderedIds[(start + i) % orderedIds.length];
    if (id !== undefined && waiting(id)) return id;
  }
  return null;
}

/** The React-facing attention slice: the per-session state map (mirrored from the
 *  module-level counters on every activity notification and whenever the session list
 *  changes) plus the count of sessions currently needing attention (drives the
 *  jump-to-waiting affordance's visibility). */
export function useTerminalAttention(sessions: readonly TerminalSessionInfo[]): {
  attention: Readonly<Record<string, TerminalAttention>>;
  attentionCount: number;
} {
  const [attention, setAttention] = useState<Readonly<Record<string, TerminalAttention>>>({});
  useEffect(() => {
    const recompute = () => {
      const next: Record<string, TerminalAttention> = {};
      for (const s of sessions) next[s.id] = getAttention(s.id);
      setAttention(next);
    };
    recompute();
    return subscribeActivity(recompute);
  }, [sessions]);
  const attentionCount = useMemo(
    () => Object.values(attention).filter((a) => a.needsAttention).length,
    [attention],
  );
  return { attention, attentionCount };
}

/** Register the output-side completion/awaiting-signal handlers on a session's xterm:
 *  the standard desktop-notification OSC codes (9 = iTerm/growl, 99 = kitty, 777 =
 *  urxvt notify) and the terminal BEL. Any of them, fired while the pane is off-screen,
 *  flips the tab to needs-attention. This parses only the bytes the shell EMITS — it
 *  never touches the PTY, so the USER-ONLY seam holds. Disposed with the terminal.
 *  Returns the disposables (the caller may drop them; `term.dispose()` also releases). */
export function installCompletionSignals(term: Terminal, id: string): IDisposable[] {
  const signal = (): void => {
    // Two independent consumers: the badge (gated on visibility) and the desktop
    // notification (gated on focus/visibility + setting, off the completion stream).
    recordAttention(id);
    emitCompletion(id);
  };
  const onOsc = (): boolean => {
    signal();
    // `true` = handled, so xterm doesn't log an unknown-OSC warning. These codes have
    // no visual effect we'd lose by consuming them.
    return true;
  };
  return [
    term.parser.registerOscHandler(9, onOsc),
    term.parser.registerOscHandler(99, onOsc),
    term.parser.registerOscHandler(777, onOsc),
    term.onBell(signal),
  ];
}
