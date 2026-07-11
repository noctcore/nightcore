/**
 * The imperative xterm-instance manager for the Terminal feature — the one place
 * that owns live `@xterm/xterm` instances and their binding to the PTY bridge.
 *
 * WHY A MODULE-LEVEL CACHE (the remount/re-attach answer): the shell's routed-view
 * container remounts on every nav switch (AnimatePresence), so the only way a
 * session's rendered scrollback survives a view switch is to keep the xterm instance
 * alive across React remounts — a module-level `Map<sessionId, CachedSession>` here,
 * outside the component tree. The channel handler writes bytes straight into the
 * (always-alive) xterm even while its pane is unmounted, so a background tab keeps
 * buffering. React state (the tab list) is derived; this map is the source of truth.
 * `openSession` spawns + caches; `attachSession` moves the persistent host into the
 * live pane and wires input/resize; `closeSession` kills + disposes. Pure lifecycle.
 */
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { IDisposable } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';

import type {
  SpawnTerminalOpts,
  TerminalByteHandler,
  TerminalHandle,
  TerminalSessionInfo,
} from '@/lib/bridge';
import {
  attachTerminal,
  killTerminal,
  resizeTerminal,
  spawnTerminal,
  writeTerminal,
} from '@/lib/bridge';

import { forgetCommandCapture, recordCommandInput } from './terminal-command-capture';
import { installKeymap } from './terminal-keymap';
import {
  buildTerminalOptions,
  openTerminalLink,
  type TerminalRenderPrefs,
} from './terminal-render';
import { DEFAULT_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_SCROLLBACK } from './terminal-shared';
import { loadWebgl, type WebglController } from './terminal-webgl';

export type { TerminalRenderPrefs } from './terminal-render';

/** The current render prefs new sessions spawn with. Seeded to the shipped defaults
 *  and overwritten by {@link applyRenderPrefs} when Settings resolve. */
let currentRenderPrefs: TerminalRenderPrefs = {
  fontSize: DEFAULT_TERMINAL_FONT_SIZE,
  scrollback: DEFAULT_TERMINAL_SCROLLBACK,
};

/** How long to settle rapid ResizeObserver bursts before telling the PTY (the
 *  reference apps all debounce ~100ms so a drag-resize doesn't spam SIGWINCH). */
const RESIZE_DEBOUNCE_MS = 100;

interface CachedSession {
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
  /** Unread-output activity count (decision 6c): batches that landed while this
   *  session was NOT the visible tab. Generic byte-activity — never Claude-output
   *  parsing. Cleared when the session becomes active or the window regains focus.
   *  Lives here (module-level, not React) so it survives the view's remounts. */
  unread: number;
}

const cache = new Map<string, CachedSession>();
const encoder = new TextEncoder();

/** Activity (unread-badge) plumbing — the session manager is module-level, so a
 *  tiny subscription bridges its counters to the React hook that renders badges. */
type ActivityListener = () => void;
const activityListeners = new Set<ActivityListener>();
/** The session ids currently visible on screen. Output for a visible id never
 *  badges; every other session's output bumps its unread count. In tabs mode this
 *  is the single active tab; in grid mode (PR 2) it is EVERY mounted pane (or just
 *  the zoomed one) — so only zoomed-away / off-screen panes badge. */
let visibleIds: Set<string> = new Set();

function notifyActivity(): void {
  for (const fn of activityListeners) fn();
}

/** Record one output batch for `id`: bump its unread badge + notify, unless it is
 *  currently visible (which never accrues unread). A no-op for an unknown id. */
function recordActivity(id: string): void {
  if (visibleIds.has(id)) return;
  const entry = cache.get(id);
  if (entry === undefined) return;
  entry.unread += 1;
  notifyActivity();
}

/** Subscribe to activity changes (any unread bump or clear). Returns an
 *  unsubscribe. The hook re-derives per-tab badge counts on each notification. */
export function subscribeActivity(fn: ActivityListener): () => void {
  activityListeners.add(fn);
  return () => {
    activityListeners.delete(fn);
  };
}

/** The current unread-output count for a session (0 for unknown / visible ids). */
export function getUnread(id: string): number {
  return cache.get(id)?.unread ?? 0;
}

/** Clear a session's unread badge (focus regain / activation). Notifies only when
 *  it actually changed, so a no-op clear doesn't churn the subscribers. */
export function clearUnread(id: string): void {
  const entry = cache.get(id);
  if (entry === undefined || entry.unread === 0) return;
  entry.unread = 0;
  notifyActivity();
}

/** Mark the set of currently-visible sessions (grid mode, PR 2): each stops
 *  accruing unread and its badge clears immediately; every other session keeps
 *  badging its background output. Passing every mounted pane's id in grid mode, or
 *  just the zoomed pane's id, is what makes only off-screen panes badge. */
export function setVisibleTerminals(ids: readonly string[]): void {
  visibleIds = new Set(ids);
  for (const id of ids) clearUnread(id);
}

/** Mark `id` the single visible/active session (tabs mode): it stops accruing
 *  unread and its badge clears immediately; `null` (no active tab) leaves every
 *  session eligible to badge. A thin wrapper over {@link setVisibleTerminals}. */
export function setActiveTerminal(id: string | null): void {
  setVisibleTerminals(id === null ? [] : [id]);
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

/** Find the next `query` match in a session's scrollback and reveal it. `incremental`
 *  keeps the search anchored near the viewport as the user types. Returns whether a
 *  match was found (drives the find bar's no-match style). No-op `false` for an
 *  unknown id. */
export function searchNext(id: string, query: string, incremental: boolean): boolean {
  const entry = cache.get(id);
  if (entry === undefined) return false;
  return entry.search.findNext(query, { incremental });
}

/** Find the previous `query` match in a session's scrollback. */
export function searchPrevious(id: string, query: string): boolean {
  const entry = cache.get(id);
  if (entry === undefined) return false;
  return entry.search.findPrevious(query);
}

/** Clear a session's search highlight decorations (find bar closed / query emptied). */
export function clearSearch(id: string): void {
  cache.get(id)?.search.clearDecorations();
}

/** Return keyboard focus to a session's terminal (after the find bar closes). */
export function focusSession(id: string): void {
  const entry = cache.get(id);
  if (entry === undefined || !entry.opened) return;
  entry.term.focus();
}

// --- Render preferences (spec PR 3d) ---------------------------------------

/** Apply the font-size / scrollback render prefs (spec PR 3d) to EVERY live session
 *  and remember them for future spawns. xterm applies `options` changes live, so a
 *  font-size change repaints without reopening; scrollback resizes the buffer that
 *  future output fills. Each live term is re-`fit()`ed since a font-size change
 *  alters the cols/rows the container holds. */
export function applyRenderPrefs(prefs: TerminalRenderPrefs): void {
  currentRenderPrefs = prefs;
  for (const entry of cache.values()) {
    entry.term.options.fontSize = prefs.fontSize;
    entry.term.options.scrollback = prefs.scrollback;
    if (!entry.opened) continue;
    refitSession(entry.session.id);
  }
}

/** Create + cache a live xterm bound to a PTY stream via `bind` (a fresh spawn or a
 *  daemon reattach). The xterm is created BEFORE `bind` so the channel's first bytes
 *  (banner/prompt, or the replayed tail) are captured — xterm buffers pre-`open()`
 *  writes. Disposes the throwaway instance + rejects on a `bind` failure (cap /
 *  rejected cwd / no live session). Shared by {@link openSession}/{@link reattachSession}. */
async function installSession(
  webgl: boolean,
  bind: (onData: TerminalByteHandler) => Promise<TerminalHandle>,
): Promise<TerminalSessionInfo> {
  const term = new Terminal(buildTerminalOptions(currentRenderPrefs));
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Scrollback search + https-only web links (spec PR 3c) — both tolerate a
  // not-yet-opened terminal, like the fit addon.
  const search = new SearchAddon();
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_event, uri) => openTerminalLink(uri)));

  // The id is server-minted (only known once `bind` resolves) but output arrives
  // strictly after — a holder lets the byte callback record activity for the right id.
  let sessionId: string | null = null;
  let handle: TerminalHandle;
  try {
    handle = await bind((bytes) => {
      term.write(bytes);
      if (sessionId !== null) recordActivity(sessionId);
    });
  } catch (err) {
    term.dispose();
    throw err;
  }
  sessionId = handle.session.id;
  // Clipboard smarts + app-chord swallowing (spec PR 3b) — installed now that the
  // session id (the PTY write target for Shift+Enter / kill-line) is known.
  installKeymap(term, handle.session.id);

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  cache.set(handle.session.id, {
    session: handle.session,
    term,
    fit,
    search,
    handle,
    host,
    opened: false,
    input: null,
    webgl,
    webglController: null,
    rendererStarted: false,
    unread: 0,
  });
  return handle.session;
}

/** Spawn a shell and cache a live xterm bound to its output stream. Rejects (disposing
 *  the throwaway instance) when the server refuses — over the cap or a rejected cwd. */
export async function openSession(
  opts: SpawnTerminalOpts,
  webgl = false,
): Promise<TerminalSessionInfo> {
  return installSession(webgl, (onData) => spawnTerminal(opts, onData));
}

/** Reattach to an EXISTING live session (cockpit spec PR 6 — detached-daemon reattach
 *  on relaunch): a fresh xterm bound to its replayed + live output. Called on mount for
 *  each session `listTerminals()` reported live but with no local instance — only after
 *  a restart in daemon mode (in-process the list is empty, so this never fires). */
export async function reattachSession(
  session: TerminalSessionInfo,
  webgl = false,
): Promise<TerminalSessionInfo> {
  return installSession(webgl, (onData) => attachTerminal(session.id, onData));
}

/** Load the WebGL renderer for a session that opted in (decision 7) — called by the
 *  pane once its terminal is open. One-time per session (guarded), and only when the
 *  GPU toggle was on at spawn. `onContextLoss` is invoked if the WebGL context is
 *  later lost, AFTER this manager has already disposed the addon (reverting to DOM);
 *  the caller uses it to toast the degrade. A no-op for DOM sessions / unknown ids /
 *  when WebGL is unavailable. */
export async function ensureRenderer(id: string, onContextLoss: () => void): Promise<void> {
  const entry = cache.get(id);
  if (entry === undefined || !entry.webgl || entry.rendererStarted || !entry.opened) return;
  // Mark started BEFORE the await so a re-attach mid-load can't double-load.
  entry.rendererStarted = true;
  const controller = await loadWebgl(entry.term, () => {
    // Context lost: dispose the addon (xterm reverts to DOM) and notify the caller.
    entry.webglController?.dispose();
    entry.webglController = null;
    onContextLoss();
  });
  // The session may have been closed while the addon loaded — don't resurrect it.
  if (!cache.has(id)) {
    controller?.dispose();
    return;
  }
  entry.webglController = controller;
}

/** Mount a cached session's terminal into `container` and wire input + resize.
 *  Idempotent per session: the xterm is `open()`ed once (first attach) then its
 *  host is merely re-appended on later attaches. Returns a detach that removes the
 *  host from the DOM but KEEPS the instance alive (output keeps flowing into its
 *  buffer). Returns a no-op when the session isn't cached (e.g. a server session
 *  with no local instance — a post-reload edge, restored properly in PR C). */
export function attachSession(id: string, container: HTMLElement): () => void {
  const entry = cache.get(id);
  if (entry === undefined) return () => {};

  container.appendChild(entry.host);
  if (!entry.opened) {
    entry.term.open(entry.host);
    entry.opened = true;
    // Write path: xterm keystrokes → terminal_write + the opt-in AI-naming capture.
    entry.input = entry.term.onData((data) => {
      void writeTerminal(id, encoder.encode(data));
      recordCommandInput(id, data);
    });
  }

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const applyFit = () => {
    if (entry.host.clientWidth === 0 || entry.host.clientHeight === 0) return;
    try {
      entry.fit.fit();
    } catch {
      // A zero/detached host can throw mid-teardown; the observer settles it.
      return;
    }
    void resizeTerminal(id, entry.term.cols, entry.term.rows);
  };
  const scheduleFit = () => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyFit, RESIZE_DEBOUNCE_MS);
  };

  // Fit once after layout settles, then track container size.
  const raf = requestAnimationFrame(applyFit);
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(entry.host);
  entry.term.focus();

  return () => {
    cancelAnimationFrame(raf);
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    observer.disconnect();
    if (entry.host.parentElement === container) container.removeChild(entry.host);
  };
}

/** Kill a session's shell server-side and dispose its local instance. Idempotent. */
export async function closeSession(id: string): Promise<void> {
  const entry = cache.get(id);
  cache.delete(id);
  forgetCommandCapture(id); // drop any AI-naming capture state (round-2 PR A)
  if (entry === undefined) return;
  try {
    await killTerminal(id);
  } finally {
    entry.input?.dispose();
    entry.webglController?.dispose();
    entry.handle.detach();
    entry.host.remove();
    entry.term.dispose();
  }
}

/** Whether a live xterm instance exists for `id`. */
export function hasSession(id: string): boolean {
  return cache.has(id);
}

/** Drop any cached instances whose ids are absent from `liveIds` (reaped
 *  server-side — the shell exited). Called on view mount to reconcile the cache
 *  with server truth so a dead tab's instance doesn't linger. */
export function reconcileSessions(liveIds: readonly string[]): void {
  const live = new Set(liveIds);
  for (const id of [...cache.keys()]) {
    if (!live.has(id)) void closeSession(id);
  }
}
