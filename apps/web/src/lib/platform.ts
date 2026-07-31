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
 *  15.7 (2026-05). Its fix, xtermjs#5883 ("Fix webgl rendering corruption from atlas
 *  page merges"), DID merge upstream on 2026-05-21 — but it is not in anything we can
 *  take yet, re-verified 2026-07-31 (#430):
 *
 *  - every file it touches is under `addons/addon-webgl/src`, so the fix ships in
 *    `@xterm/addon-webgl`, NOT in the `@xterm/xterm` core;
 *  - that package's newest STABLE release is still `0.19.0` (2025-12-22) — the version
 *    pinned here — which predates the merge and does not contain it;
 *  - the first published artifact carrying it is the `0.20.0-beta.219` PRERELEASE, and
 *    its peer range demands a beta core (`@xterm/xterm@^6.1.0-beta.*`), so taking the
 *    fix today means moving the whole terminal stack onto the beta channel.
 *
 *  xterm 6 removed the canvas renderer, so a corrupted GPU context has nothing to fall
 *  back to but DOM. Turning it on by default on WebKit would therefore ship visible
 *  corruption; Windows (WebView2) and Linux get the GPU renderer.
 *
 *  A user's explicit toggle always wins — this is only the unset resolution. Flip the
 *  `IS_MAC` guard when a STABLE `@xterm/addon-webgl` (0.20.0 or later) carrying #5883
 *  is released AND taken here; #5816's own open/closed state is not the trigger, since
 *  an issue can outlive its fix. Check with `npm view @xterm/addon-webgl version`. */
export const DEFAULT_TERMINAL_WEBGL = !IS_MAC;

/** Resolve the effective terminal-renderer choice: the stored preference when the user
 *  has one, else {@link DEFAULT_TERMINAL_WEBGL}. Pure — the single place the tri-state
 *  is collapsed, so the Settings toggle and the terminal view can never disagree. */
export function resolveTerminalWebgl(stored: boolean | null | undefined): boolean {
  return stored ?? DEFAULT_TERMINAL_WEBGL;
}
