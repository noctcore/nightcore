/**
 * The live-xterm cache and the read-only accessors over it — the half of the Terminal
 * session manager that only ever LOOKS at a cached instance (search, scroll, refit,
 * focus), split out so the manager keeps just the lifecycle (spawn / attach / close /
 * reconcile / render prefs) and both stay under the 400-line file-size ratchet.
 *
 * WHY A MODULE-LEVEL CACHE (the remount/re-attach answer): the shell's routed-view
 * container remounts on every nav switch (AnimatePresence), so the only way a session's
 * rendered scrollback survives a view switch is to keep the xterm instance alive across
 * React remounts — this `Map<sessionId, CachedSession>`, outside the component tree. The
 * channel handler writes bytes straight into the (always-alive) xterm even while its
 * pane is unmounted, so a background tab keeps buffering. React state (the tab list) is
 * derived; this map is the source of truth.
 *
 * Every accessor here is a no-op / empty result for an unknown id, so a caller never has
 * to guard against "the session was closed between render and effect".
 *
 * The manager re-exports this module's public surface, so consumers (and the view's test
 * mock) keep importing from `terminal-session-manager` exactly as before.
 */
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';
import type { IDisposable, Terminal } from '@xterm/xterm';

import type { TerminalHandle, TerminalSessionInfo } from '@/lib/bridge';
import { resizeTerminal } from '@/lib/bridge';

import type { WebglController } from './terminal-webgl';

/** One live session's instance state. Mutable fields are driven by the manager's
 *  lifecycle; the readonly ones are fixed at install. */
export interface CachedSession {
  readonly session: TerminalSessionInfo;
  readonly term: Terminal;
  readonly fit: FitAddon;
  /** Per-session scrollback search (spec PR 3c) — driven by the find bar. */
  readonly search: SearchAddon;
  readonly handle: TerminalHandle;
  /** The persistent element the terminal is opened into once, then MOVED between
   *  panes across remounts (never re-opened — re-opening loses buffer state). */
  readonly host: HTMLDivElement;
  opened: boolean;
  input: IDisposable | null;
  /** Whether this session opted into the WebGL/GPU renderer (decision 7). */
  readonly webgl: boolean;
  /** The loaded WebGL renderer, or `null` while on DOM (never enabled, still
   *  loading, or fell back after a context loss). */
  webglController: WebglController | null;
  /** Guards the one-time renderer load against re-attach churn. */
  rendererStarted: boolean;
}

/** The one live-instance map. `pub` to this feature only — nothing outside the
 *  `terminal-session-*` pair should reach into it directly. */
export const cache = new Map<string, CachedSession>();

/** Whether a live xterm instance exists for `id`. */
export function hasSession(id: string): boolean {
  return cache.has(id);
}

/** Re-fit a live session's terminal to its (now resized) host and repaint it — used
 *  after a grid relayout / drag-drop / zoom transition, where a pane's cell changed
 *  size (or transiently collapsed to 0px during a drag) and `fit()` alone, seeing no
 *  net dimension change, would leave a blank/stale canvas. Fits, tells the PTY the
 *  new geometry, then forces a full `refresh`. A no-op for an unopened / unknown id
 *  or a zero-size host (the ResizeObserver settles the latter). */
export function refitSession(id: string): void {
  const entry = cache.get(id);
  if (entry === undefined || !entry.opened) return;
  if (entry.host.clientWidth === 0 || entry.host.clientHeight === 0) return;
  try {
    entry.fit.fit();
  } catch {
    // A detached/zero host can throw mid-teardown; the observer settles it.
    return;
  }
  void resizeTerminal(id, entry.term.cols, entry.term.rows);
  entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
}

// --- Search-in-scrollback (spec PR 3c) -------------------------------------

// Passing `decorations` makes @xterm/addon-search highlight EVERY match AND emit
// `onDidChangeResults` — the event the find bar's "n/m" counter binds to. `#RRGGBB`
// is required for the fills; the palette tracks the cosmic purple theme.
const SEARCH_DECORATIONS = {
  matchBackground: '#5b3aa6',
  matchOverviewRuler: '#7c5cd6',
  activeMatchBackground: '#a78bfa',
  activeMatchColorOverviewRuler: '#c4b5fd',
} as const;

/** Active match index (`-1` when none selected / threshold exceeded) + total count. */
export interface SearchResults {
  readonly resultIndex: number;
  readonly resultCount: number;
}

/** Subscribe to a session's search-results changes (count + active index). Returns an
 *  unsubscribe fn, or `undefined` for an unknown id. */
export function onSearchResults(
  id: string,
  listener: (results: SearchResults) => void,
): (() => void) | undefined {
  const entry = cache.get(id);
  if (entry === undefined) return undefined;
  const disposable = entry.search.onDidChangeResults(listener);
  return () => disposable.dispose();
}

/** Find + reveal the next `query` match. `incremental` keeps the search anchored near
 *  the viewport as the user types. Returns whether a match was found (`false` for an
 *  unknown id, driving the no-match style). */
export function searchNext(id: string, query: string, incremental: boolean): boolean {
  const entry = cache.get(id);
  if (entry === undefined) return false;
  return entry.search.findNext(query, { incremental, decorations: SEARCH_DECORATIONS });
}

/** Find the previous `query` match in a session's scrollback. */
export function searchPrevious(id: string, query: string): boolean {
  const entry = cache.get(id);
  if (entry === undefined) return false;
  return entry.search.findPrevious(query, { decorations: SEARCH_DECORATIONS });
}

/** Clear a session's search highlight decorations (find bar closed / query emptied). */
export function clearSearch(id: string): void {
  cache.get(id)?.search.clearDecorations();
}

/** Return keyboard focus to a session's terminal (after the find bar closes, or when
 *  ⌘1..9 selects a tab — #405's focus-follows-pane needs focus to actually MOVE, not
 *  just the active id to change). */
export function focusSession(id: string): void {
  const entry = cache.get(id);
  if (entry === undefined || !entry.opened) return;
  entry.term.focus();
}

// --- Scroll position (jump-to-bottom chip) ---------------------------------

/** Subscribe to whether a session's viewport is pinned to the buffer bottom. Emits the
 *  current state immediately, then on each scroll (xterm auto-scrolls on new output
 *  while pinned). Returns an unsubscribe fn, or `undefined` for an unknown id. */
export function onSessionScroll(
  id: string,
  listener: (atBottom: boolean) => void,
): (() => void) | undefined {
  const entry = cache.get(id);
  if (entry === undefined) return undefined;
  const atBottom = () => entry.term.buffer.active.viewportY >= entry.term.buffer.active.baseY;
  listener(atBottom());
  const disposable = entry.term.onScroll(() => listener(atBottom()));
  return () => disposable.dispose();
}

/** Scroll a session's terminal to the bottom of its buffer (the jump-to-bottom chip). */
export function scrollSessionToBottom(id: string): void {
  cache.get(id)?.term.scrollToBottom();
}
