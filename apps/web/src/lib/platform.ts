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
