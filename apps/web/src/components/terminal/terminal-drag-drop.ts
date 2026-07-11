/**
 * Drag a file/folder onto a terminal pane → type its shell-escaped ABSOLUTE path at
 * the prompt (round-2 PR C). A feature-root module (like `terminal-broadcast` /
 * `terminal-command-capture`) so the pure compose + hit-test logic is unit-testable
 * and the webview-listener hook stays out of the 400-line view hook (the sanctioned
 * `terminal-*.ts` escape valve).
 *
 * WHY NATIVE `onDragDropEvent` (not HTML5 `ondrop`): `dragDropEnabled` is unset in
 * `tauri.conf.json`, so it defaults to Tauri v2 `true` — the webview's OS file drop is
 * handled by Tauri and the HTML5 `ondrop` DOM event is SUPPRESSED; and even if it
 * fired, a webview `File` never exposes an absolute path. Tauri's native
 * `getCurrentWebview().onDragDropEvent` delivers absolute `paths[]` + a physical cursor
 * position, which is exactly what a "type the path" gesture needs. The listener is
 * webview-GLOBAL, so the position is hit-tested to the pane under the cursor via
 * `data-session-id` (both pane modes tag their root with it).
 *
 * USER-ONLY seam: a drop is a human drag gesture writing into the human's own PTY via
 * the existing `terminal_write` path — no agent path reaches this. The write is targeted
 * to the hit-tested pane only; it deliberately does NOT fan out through the broadcast
 * writer (a drop lands where the file was dropped, not on every pane).
 *
 * Fail-soft everywhere: a drop that can't resolve to a POSIX pane with a non-empty
 * escaped path is a silent no-op, never an error. POSIX-shell only in v1 — the escaping
 * is POSIX single-quote; a PowerShell/cmd target is skipped (matching the composed-launch
 * posture).
 */
import { useEffect, useRef, useState } from 'react';

import type { TerminalSessionInfo } from '@/lib/bridge';
import { isTauri, writeTerminal } from '@/lib/bridge';

import { isPosixShell, shellQuotePosix } from './terminal-inject';

const encoder = new TextEncoder();

/** Shell-escape each absolute path (POSIX single-quote wrapping, `'` → `'\''`) and join
 *  multiple with spaces — the exact text typed at the prompt. Reuses the claude-launch
 *  cwd escaper ({@link shellQuotePosix}) so a drop and a launch quote identically. Empty
 *  entries are dropped; an empty result means "nothing to type". Pure + unit-tested. */
export function composeDroppedPaths(paths: readonly string[]): string {
  return paths
    .filter((path) => path !== '')
    .map((path) => shellQuotePosix(path))
    .join(' ');
}

/** Walk up from `el` to the nearest pane root carrying `data-session-id` and return that
 *  id, or `null` when the point is outside every pane. Both pane modes tag their root div
 *  with `data-session-id` (tabs: the active pane; grid: each visible pane), so this one
 *  walk resolves the target in either layout. Pure over the DOM — unit-tested with
 *  constructed elements. */
export function paneIdFromElement(el: Element | null): string | null {
  return el?.closest<HTMLElement>('[data-session-id]')?.dataset.sessionId ?? null;
}

/** Hit-test a LOGICAL (CSS-pixel) viewport point to the pane under it. `onDragDropEvent`
 *  reports a PHYSICAL cursor position, so the caller converts it to logical first
 *  (`toLogical(devicePixelRatio)`) — `elementFromPoint` speaks CSS pixels. */
function paneIdAtPoint(x: number, y: number): string | null {
  return paneIdFromElement(document.elementFromPoint(x, y));
}

/** The fail-soft core of a drop: resolve the dropped `paths` for the hit-tested
 *  `sessionId` into the exact text to type, or `null` for a no-op. Null when the drop
 *  missed every pane (`sessionId === null`), the pane's session is gone, its shell is
 *  non-POSIX (v1 only escapes POSIX single-quote — a PowerShell/cmd target is skipped),
 *  or there is nothing to type. Pure + unit-tested — the drop decision lives here, not in
 *  the listener glue. */
export function planDrop(
  paths: readonly string[],
  sessionId: string | null,
  sessions: readonly TerminalSessionInfo[],
): { id: string; text: string } | null {
  if (sessionId === null) return null;
  const session = sessions.find((s) => s.id === sessionId);
  if (session === undefined || !isPosixShell(session.shell)) return null;
  const text = composeDroppedPaths(paths);
  if (text === '') return null;
  return { id: sessionId, text };
}

/** Input to {@link useTerminalDragDrop}. */
export interface UseTerminalDragDropInput {
  /** The live sessions — the drop looks up the hit-tested pane's session to gate on a
   *  POSIX shell and to write into the right PTY. */
  readonly sessions: readonly TerminalSessionInfo[];
}

/** The drag-drop state the Terminal view exposes to its panes. */
export interface TerminalDragDropState {
  /** The session id of the pane currently under a dragged file (the drag-over
   *  highlight), or `null`. Threaded to the panes so the one under the cursor shows the
   *  drop hint. */
  readonly dropTargetId: string | null;
}

/** Register the webview-global native file-drop listener for the Terminal view and drive
 *  the drop-target highlight + the escaped-path write. The `@tauri-apps/api/webview`
 *  import is DYNAMIC + try-guarded (§9f) so vitest / browser-preview contexts (where the
 *  native drop API is absent) are a clean no-op that never throws. Unlistens on unmount. */
export function useTerminalDragDrop({ sessions }: UseTerminalDragDropInput): TerminalDragDropState {
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // Latest sessions read by the async listener without re-subscribing on every change.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    // The native drop API lives in the Tauri webview only. Guard the DYNAMIC import with
    // `isTauri()` — exactly the bridge's idiom (§9f) — so outside the webview (vitest,
    // Storybook, browser preview) the module is never even loaded. That both no-ops
    // cleanly AND keeps vitest's browser dep-optimizer from discovering `@tauri-apps/
    // api/webview` mid-run and reloading the page (the known re-optimize flake).
    if (!isTauri()) return;

    let unlisten: (() => void) | null = null;
    let disposed = false;

    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const un = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'leave') {
            setDropTargetId(null);
            return;
          }
          // `enter` / `over` / `drop` all carry a PHYSICAL position; convert to CSS
          // pixels for `elementFromPoint` (which speaks logical pixels).
          const point = payload.position.toLogical(window.devicePixelRatio);
          const id = paneIdAtPoint(point.x, point.y);
          if (payload.type === 'drop') {
            setDropTargetId(null);
            const plan = planDrop(payload.paths, id, sessionsRef.current);
            // No trailing newline — the user reviews the path then presses Enter.
            if (plan !== null) void writeTerminal(plan.id, encoder.encode(plan.text));
            return;
          }
          // enter / over → move the drop-hint to the pane under the cursor (or clear it
          // when the cursor is between panes).
          setDropTargetId(id);
        });
        // The view may have unmounted while the listener was registering.
        if (disposed) un();
        else unlisten = un;
      } catch {
        // Non-Tauri context or a listener-registration failure: no native drops to
        // handle. Fail-soft — the terminal keeps working without drag-to-path.
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return { dropTargetId };
}
