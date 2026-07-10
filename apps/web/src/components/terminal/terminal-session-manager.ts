/**
 * The imperative xterm-instance manager for the Terminal feature — the one place
 * that owns live `@xterm/xterm` instances and their binding to the PTY bridge.
 *
 * WHY A MODULE-LEVEL CACHE (the remount/re-attach answer): the shell's routed-view
 * container remounts on every nav switch (AnimatePresence), and PR A exposes NO
 * live-session scrollback read (`terminal_read_persisted` covers dead sessions
 * only, for the PR C restore UI). So the ONLY way a session's rendered scrollback
 * survives a view switch is to keep the xterm instance itself alive across React
 * remounts — a module-level `Map<sessionId, CachedSession>` here, outside the
 * component tree. The channel handler writes bytes straight into the (always-alive)
 * xterm even while its pane is unmounted, so a background tab keeps buffering
 * exactly like the reference apps. React state (the tab list) is derived; this map
 * is the source of truth for instances. `openSession` creates + spawns + caches;
 * `attachSession` moves the persistent host element into the live pane and wires
 * input/resize; `closeSession` kills + disposes. Not a React hook — pure lifecycle.
 */
import { FitAddon } from '@xterm/addon-fit';
import type { IDisposable } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';

import type { SpawnTerminalOpts, TerminalHandle, TerminalSessionInfo } from '@/lib/bridge';
import { killTerminal, resizeTerminal, spawnTerminal, writeTerminal } from '@/lib/bridge';

/** Fixed cosmic-dark xterm styling. WKWebView needs an explicit `fontSize` /
 *  `fontFamily` (the feasibility trap list) — inherited page fonts don't reach
 *  xterm's canvas/DOM cells. */
const TERMINAL_OPTIONS = {
  fontSize: 13,
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  lineHeight: 1.2,
  cursorBlink: true,
  // DOM renderer only in PR B (no WebGL addon loaded — that arrives in PR C behind
  // the GPU toggle). xterm 6's default renderer is DOM, so simply not loading the
  // WebGL addon IS the DOM-only choice.
  theme: {
    background: '#0a0a0f',
    foreground: '#e4e4ef',
    cursor: '#a78bfa',
    selectionBackground: 'rgba(167, 139, 250, 0.3)',
  },
} as const;

/** How long to settle rapid ResizeObserver bursts before telling the PTY (the
 *  reference apps all debounce ~100ms so a drag-resize doesn't spam SIGWINCH). */
const RESIZE_DEBOUNCE_MS = 100;

interface CachedSession {
  readonly session: TerminalSessionInfo;
  readonly term: Terminal;
  readonly fit: FitAddon;
  readonly handle: TerminalHandle;
  /** The persistent element the terminal is opened into once, then MOVED between
   *  panes across remounts (never re-opened — re-opening loses buffer state). */
  readonly host: HTMLDivElement;
  opened: boolean;
  input: IDisposable | null;
}

const cache = new Map<string, CachedSession>();
const encoder = new TextEncoder();

/** Spawn a shell and cache a live xterm bound to its output stream. The xterm is
 *  created BEFORE `spawnTerminal` so the channel's first bytes (banner/prompt) are
 *  captured — xterm buffers writes issued before `open()`. Rejects (and disposes
 *  the throwaway instance) when the server refuses: over the 8-session cap or a
 *  rejected cwd. The caller surfaces that. */
export async function openSession(opts: SpawnTerminalOpts): Promise<TerminalSessionInfo> {
  const term = new Terminal(TERMINAL_OPTIONS);
  const fit = new FitAddon();
  term.loadAddon(fit);

  let handle: TerminalHandle;
  try {
    handle = await spawnTerminal(opts, (bytes) => term.write(bytes));
  } catch (err) {
    term.dispose();
    throw err;
  }

  const host = document.createElement('div');
  host.style.width = '100%';
  host.style.height = '100%';
  cache.set(handle.session.id, {
    session: handle.session,
    term,
    fit,
    handle,
    host,
    opened: false,
    input: null,
  });
  return handle.session;
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
    // Write path: xterm keystrokes/paste → terminal_write.
    entry.input = entry.term.onData((data) => {
      void writeTerminal(id, encoder.encode(data));
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
  if (entry === undefined) return;
  try {
    await killTerminal(id);
  } finally {
    entry.input?.dispose();
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
