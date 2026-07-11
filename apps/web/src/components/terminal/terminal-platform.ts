/**
 * Platform probe + keyboard-hint formatting for the Terminal cockpit (spec PR 3a).
 * The cockpit shortcuts and clipboard smarts are platform-correct — ⌘ on macOS,
 * Ctrl elsewhere — so both the keymap (which chord is copy vs SIGINT) and the
 * visible `Kbd` hints read one source of truth here.
 *
 * The value seeds from the browser's `navigator` (WKWebView reports `MacIntel` /
 * `Macintosh` reliably) so it is correct before any async probe resolves, then the
 * Terminal view refines it from the Rust `AppInfo.os` (`std::env::consts::OS`) once
 * `getAppInfo()` returns. A plain module-level flag, not React state — the keymap
 * closures read {@link isMacPlatform} at key-press time, well after both sources
 * have settled.
 */

/** Detect macOS from the browser as the pre-probe default. `navigator.platform` is
 *  deprecated but still populated in WKWebView; the UA is the belt-and-suspenders. */
function detectMacFromNavigator(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform ?? '';
  const ua = navigator.userAgent ?? '';
  return /mac/i.test(platform) || /mac os x|macintosh/i.test(ua);
}

let mac = detectMacFromNavigator();

/** Refine the platform from the Rust host OS (`AppInfo.os`) once known. A `null` /
 *  undefined os (outside Tauri) leaves the navigator-derived default in place. */
export function setTerminalPlatform(os: string | null | undefined): void {
  if (os === 'macos') mac = true;
  else if (os !== null && os !== undefined) mac = false;
}

/** Whether the primary shortcut modifier is ⌘ (macOS) rather than Ctrl. */
export function isMacPlatform(): boolean {
  return mac;
}

/** Format a chord for a `Kbd` hint / tooltip, platform-correct: `⌘T` / `Ctrl+T`,
 *  `⌘⇧E` / `Ctrl+Shift+E`. `key` is the letter (case-insensitive). */
export function formatShortcut(key: string, opts?: { shift?: boolean }): string {
  const upper = key.toUpperCase();
  const shift = opts?.shift ?? false;
  if (mac) return `⌘${shift ? '⇧' : ''}${upper}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${upper}`;
}
