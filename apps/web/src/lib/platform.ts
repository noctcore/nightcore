/** Platform detection for keyboard-accelerator hints. Kept in one place so the
 *  Cmd/Ctrl+Enter confirm chord renders the right modifier everywhere instead of
 *  a hardcoded ⌘ that lies on Windows/Linux (where the same handlers fire on
 *  Ctrl). Mirrors the local detection the shared `ConfirmHint` primitive does for
 *  the house confirm dialogs — this is its in-button counterpart, for the compact
 *  single-chip hints that sit inside a submit button rather than a dialog footer. */

/** macOS (or iPadOS/iOS) — where the confirm chord shows ⌘. Everything else uses
 *  Ctrl. Computed once; guards `navigator` for non-DOM (SSR/test) contexts. */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The platform-aware Cmd/Ctrl+Enter confirm chord as a compact label for an inline
 *  `<Kbd>` chip (`⌘↵` on macOS, `Ctrl↵` elsewhere). */
export const CONFIRM_CHORD = IS_MAC ? '⌘↵' : 'Ctrl↵';

/** Whether the terminal uses the xterm WebGL/GPU renderer when Settings holds no
 *  explicit choice (`terminalWebglEnabled === null`) — #407's "WebGL default-on",
 *  scoped by the evidence rather than flipped blind.
 *
 *  ON everywhere EXCEPT macOS. The recorded terminal decision (build spec decision 7)
 *  made DOM the default "while xtermjs#5816 is open"; that issue — WebGL corruption
 *  reported from a Tauri app — is still open and was re-confirmed on shipping macOS
 *  15.7 (2026-05), with its fix PR unmerged. xterm 6 removed the canvas renderer, so
 *  a corrupted GPU context has nothing to fall back to but DOM. Turning it on by
 *  default on WebKit would therefore ship visible corruption; Windows (WebView2) and
 *  Linux get the GPU renderer.
 *
 *  A user's explicit toggle always wins — this is only the unset resolution. Flip the
 *  `IS_MAC` guard once #5816 (or xtermjs#5883) lands in a released addon. */
export const DEFAULT_TERMINAL_WEBGL = !IS_MAC;

/** Resolve the effective terminal-renderer choice: the stored preference when the user
 *  has one, else {@link DEFAULT_TERMINAL_WEBGL}. Pure — the single place the tri-state
 *  is collapsed, so the Settings toggle and the terminal view can never disagree. */
export function resolveTerminalWebgl(stored: boolean | null | undefined): boolean {
  return stored ?? DEFAULT_TERMINAL_WEBGL;
}
