/**
 * The imperative xterm-instance LIFECYCLE for the Terminal feature — the one place that
 * creates, binds, mounts, and disposes live `@xterm/xterm` instances against the PTY
 * bridge. `openSession` spawns + caches; `reattachSession` binds a daemon-owned session
 * that outlived the app; `attachSession` moves the persistent host into the live pane
 * and wires input/resize; `closeSession` kills + disposes.
 *
 * The instance MAP itself, and every look-only accessor over it (search, scroll, refit,
 * focus), live in `terminal-session-cache` — see that module for why the cache is
 * module-level rather than React state. This file re-exports that surface so
 * `terminal-session-manager` remains the feature's single import point.
 */
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
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
} from '@/lib/bridge';

import {
  forgetAttention,
  getVisibleIds,
  installCompletionSignals,
  recordActivity,
} from './terminal-attention';
import { writeToTargets } from './terminal-broadcast';
import { forgetCommandCapture, recordCommandInput } from './terminal-command-capture';
import { installKeymap } from './terminal-keymap';
import { forgetOsc133, installOsc133 } from './terminal-osc133';
import { forgetProcessTitle, recordProcessTitle } from './terminal-process-title';
import {
  buildTerminalOptions,
  openTerminalLink,
  type TerminalRenderPrefs,
} from './terminal-render';
import { cache, refitSession } from './terminal-session-cache';
import { DEFAULT_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_SCROLLBACK } from './terminal-shared';
import { loadWebgl } from './terminal-webgl';

export type { TerminalRenderPrefs } from './terminal-render';
// The look-only half lives in `terminal-session-cache` (file-size ratchet); re-exported
// here so `terminal-session-manager` stays the feature's single import surface.
export {
  clearSearch,
  focusSession,
  hasSession,
  onSearchResults,
  onSessionScroll,
  refitSession,
  scrollSessionToBottom,
  searchNext,
  searchPrevious,
  type SearchResults,
} from './terminal-session-cache';

/** The current render prefs new sessions spawn with. Seeded to the shipped defaults
 *  and overwritten by {@link applyRenderPrefs} when Settings resolve. */
let currentRenderPrefs: TerminalRenderPrefs = {
  fontSize: DEFAULT_TERMINAL_FONT_SIZE,
  scrollback: DEFAULT_TERMINAL_SCROLLBACK,
};

/** How long to settle rapid ResizeObserver bursts before telling the PTY (the
 *  reference apps all debounce ~100ms so a drag-resize doesn't spam SIGWINCH). */
const RESIZE_DEBOUNCE_MS = 100;

const encoder = new TextEncoder();

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
  // T11: parse the shell's OSC 9/99/777 + BEL completion signals → needs-attention
  // (output-side only; never touches the PTY, so the USER-ONLY seam holds). Disposed
  // with the terminal on `closeSession`.
  installCompletionSignals(term, handle.session.id);
  // #405: OSC 133 marks → command blocks + exit-status gutter decorations + the >5s
  // completion signal, and the keymap actions they power. Output-side, like above.
  const osc133 = installOsc133(term, handle.session.id);
  // Clipboard smarts + app-chord swallowing (spec PR 3b). The emit routes the manual
  // Shift+Enter / kill-line writes through the broadcast fan-out (round-2 PR B).
  installKeymap(term, {
    write: (b) => void writeToTargets(handle.session.id, b, [...getVisibleIds()]),
    // OSC 133 prompt-nav + copy-last-output (#405); no-ops for a shell with no marks.
    ...osc133,
  });
  // T11: the shell's own process-title (OSC 0/2) as the lowest-precedence auto title —
  // a better default than the cwd leaf, refused server-side over any chosen name.
  term.onTitleChange((title) => recordProcessTitle(handle.session.id, title));

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
    // Write path: keystrokes (+ pastes, which ride onData) → broadcast fan-out + AI capture.
    entry.input = entry.term.onData((data) => {
      writeToTargets(id, encoder.encode(data), [...getVisibleIds()]);
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
  forgetOsc133(id); // drop OSC 133 blocks + dispose their decorations (#405)
  forgetProcessTitle(id); // drop any pending process-title debounce (T11)
  forgetAttention(id); // drop the 3-state attention counters (T11)
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

/** Drop any cached instances whose ids are absent from `liveIds` (reaped
 *  server-side — the shell exited). Called on view mount to reconcile the cache
 *  with server truth so a dead tab's instance doesn't linger. */
export function reconcileSessions(liveIds: readonly string[]): void {
  const live = new Set(liveIds);
  for (const id of [...cache.keys()]) {
    if (!live.has(id)) void closeSession(id);
  }
}
