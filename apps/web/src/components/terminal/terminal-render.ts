/**
 * Pure render helpers for the Terminal session manager (spec PR 3): the xterm option
 * builder that folds in the live render prefs, and the https-only web-link opener.
 * Split out of the session manager so that module stays under the file-size ratchet;
 * both are stateless (the manager owns the cache + the current prefs).
 */
import { openExternal } from '@/lib/bridge';

import { TERMINAL_RENDER_OPTIONS } from './terminal-shared';

/** The two live-terminal render preferences (spec PR 3d): xterm font size (px) and
 *  scrollback length (lines). Resolved from Settings by the view and applied to every
 *  live session; new spawns read the current values. */
export interface TerminalRenderPrefs {
  readonly fontSize: number;
  readonly scrollback: number;
}

/** Live-pane xterm options: the shared cosmic-dark render config plus a blinking
 *  cursor and the current font-size / scrollback render prefs. The renderer is DOM by
 *  default; a WebGL addon is loaded post-open when the session opted into the GPU
 *  toggle (decision 7). */
export function buildTerminalOptions(prefs: TerminalRenderPrefs) {
  return {
    ...TERMINAL_RENDER_OPTIONS,
    cursorBlink: true,
    fontSize: prefs.fontSize,
    scrollback: prefs.scrollback,
  };
}

/** Open a URL from a terminal web-link (spec PR 3c). Restricted to `https://`: the
 *  shipped `open_external` command is https-only, so an `http`/`file`/other-scheme
 *  link is a deliberate no-op rather than a rejected invoke. Never widens the opener
 *  to arbitrary schemes (trap § 9n). */
export function openTerminalLink(uri: string): void {
  if (/^https:\/\//i.test(uri)) void openExternal(uri);
}
