/**
 * Shared constants + pure copy/label helpers for the Terminal feature. A plain
 * feature-root module (not a component), so the tabs bar, the pane, and the view
 * all read one source for the session cap, spawn geometry, tab labels, and the
 * identity chrome strings — no duplication across the component folders.
 */
import type { TerminalSessionInfo } from '@/lib/bridge';

/** Server-enforced max live sessions (mirrors the Rust registry cap). Used to
 *  DISABLE the new-tab affordance client-side; the authoritative guard is the
 *  `terminal_spawn` rejection, surfaced as an inline error. */
export const TERMINAL_SESSION_CAP = 8;

/** Initial PTY geometry at spawn; the pane's fit addon re-sizes on first mount. */
export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;

/** Shared xterm visual config (font + cosmic-dark theme) for BOTH the live pane and
 *  the read-only restore pane, so the two render identically. WKWebView needs an
 *  explicit `fontSize`/`fontFamily` (the feasibility trap list) — inherited page
 *  fonts don't reach xterm's cells. The live pane spreads this + `cursorBlink`; the
 *  read-only pane spreads it + `disableStdin` / no cursor. */
export const TERMINAL_RENDER_OPTIONS = {
  fontSize: 13,
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  lineHeight: 1.2,
  theme: {
    background: '#0a0a0f',
    foreground: '#e4e4ef',
    cursor: '#a78bfa',
    selectionBackground: 'rgba(167, 139, 250, 0.3)',
  },
} as const;

/** The last segment of an absolute cwd — a tab's short label. */
export function terminalLabel(cwd: string): string {
  const parts = cwd.split('/').filter((seg) => seg.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

/** Identity chrome copy (decision 1): the user terminal runs OUTSIDE the agent
 *  guardrails and the chrome must say so. `confined` is a PR C opt-in — every PR B
 *  session is unconfined — but the confined variant is defined here (and shown in
 *  stories) so PR C only has to flip the flag. */
export function identityLabel(confined: boolean): string {
  return confined ? 'Confined to this worktree' : 'Your shell — unconfined';
}

/** The hover/title explanation behind {@link identityLabel}. */
export function identityTitle(confined: boolean): string {
  return confined
    ? 'This shell runs inside the opt-in write-containment profile, scoped to its worktree.'
    : 'This is your own shell with full permissions — it runs outside the agent guardrails.';
}

/** Whether the session list has hit the live-session cap. */
export function atSessionCap(sessions: readonly TerminalSessionInfo[]): boolean {
  return sessions.length >= TERMINAL_SESSION_CAP;
}

/** Whether the host OS offers the opt-in "Confined" (Seatbelt write-containment)
 *  terminal — macOS only (decision 1). Fed by `AppInfo.os` (`std::env::consts::OS`);
 *  the new-tab picker renders the confined checkbox only when this is true. */
export function supportsConfinedTerminal(os: string | null | undefined): boolean {
  return os === 'macos';
}

/** Identity copy for a restored (read-only) tab: the shell ended and its scrollback
 *  is shown read-only until the user starts a fresh shell (decision 3). */
export function restoredIdentityLabel(): string {
  return 'Session ended — read-only';
}

/** The hover/title explanation behind {@link restoredIdentityLabel}. */
export function restoredIdentityTitle(): string {
  return 'This shell has ended. Its scrollback is shown read-only; start a fresh shell to continue in the same folder.';
}

/** Decode a base64 scrollback stream (the wire shape of a persisted session's
 *  bytes) into the raw `Uint8Array` fed verbatim to `term.write()`. Escape
 *  sequences survive because base64 is byte-exact. Returns an empty array for an
 *  empty/blank string. */
export function decodeScrollback(base64: string): Uint8Array {
  if (base64 === '') return new Uint8Array(0);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
