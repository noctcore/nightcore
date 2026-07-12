/**
 * Shared constants + pure copy/label helpers for the Terminal feature. A plain
 * feature-root module (not a component), so the tabs bar, the pane, and the view
 * all read one source for the session cap, spawn geometry, tab labels, and the
 * identity chrome strings — no duplication across the component folders.
 */
import type { TerminalSessionInfo } from '@/lib/bridge';
import { pathLeaf } from '@/lib/path-display';

// Re-exported so the terminal feature's existing `displayPath` call sites keep a
// single import surface; the implementation now lives in `@/lib/path-display` so the
// shared folder-browser primitive can display paths without a cross-feature import.
export { displayPath } from '@/lib/path-display';

/** Server-enforced max live sessions (mirrors the Rust registry cap
 *  `MAX_LIVE_SESSIONS` — both must move together). Used to DISABLE the new-tab
 *  affordance client-side; the authoritative guard is the `terminal_spawn`
 *  rejection, surfaced as an inline error. */
export const TERMINAL_SESSION_CAP = 12;

/** Initial PTY geometry at spawn; the pane's fit addon re-sizes on first mount. */
export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;

/** Live-terminal render prefs (spec PR 3d). Defaults reproduce the shipped look: the
 *  13px font ({@link TERMINAL_RENDER_OPTIONS}) and a ~10k web-side scrollback buffer
 *  (matching the Rust ring). A `null` Settings value resolves to these. */
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const DEFAULT_TERMINAL_SCROLLBACK = 10_000;
/** Sane clamp bounds so a stored/typed value can't wedge the renderer. */
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;
export const MIN_TERMINAL_SCROLLBACK = 1_000;
export const MAX_TERMINAL_SCROLLBACK = 100_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Resolve the effective terminal font size: a set value clamped to the sane range,
 *  else the shipped default. */
export function resolveFontSize(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
  return clamp(value, MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE);
}

/** Resolve the effective terminal scrollback length: a set value clamped, else the
 *  shipped default. */
export function resolveScrollback(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return DEFAULT_TERMINAL_SCROLLBACK;
  }
  return clamp(value, MIN_TERMINAL_SCROLLBACK, MAX_TERMINAL_SCROLLBACK);
}

/** Shared xterm visual config (font only) for BOTH the live pane and the read-only
 *  restore pane, so the two render identically. WKWebView needs an explicit
 *  `fontSize`/`fontFamily` (the feasibility trap list) — inherited page fonts don't
 *  reach xterm's cells. The live pane spreads this + `cursorBlink`; the read-only pane
 *  spreads it + `disableStdin` / no cursor. The COLOR theme is resolved separately at
 *  spawn time from the live design tokens — see {@link resolveTerminalTheme} (#235). */
export const TERMINAL_RENDER_OPTIONS = {
  fontSize: 13,
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  lineHeight: 1.2,
} as const;

/** The xterm theme fields Nightcore drives from the design system. */
export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
}

/** Fallback theme reproducing the shipped cosmic-dark look, used whenever the CSS
 *  custom properties can't be read (no `document`, or a stylesheet-less test host).
 *  These are the pre-token hand-eyeballed hex restatements; the live app reads the
 *  real oklch tokens via {@link resolveTerminalTheme}. */
const TERMINAL_THEME_FALLBACK: TerminalTheme = {
  background: '#0a0a0f',
  foreground: '#e4e4ef',
  cursor: '#a78bfa',
  selectionBackground: 'rgba(167, 139, 250, 0.3)',
};

/** Read a `--nc-*` design token off the document root, trimmed. Returns '' when there
 *  is no `document` (a node test host) or the property is unset — the caller then
 *  falls back to the shipped hex so xterm always receives a parseable color. */
function readCssToken(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Resolve the xterm terminal theme from the live design tokens (#235): the cosmic
 *  background/foreground and the purple cursor/selection are the SAME oklch values the
 *  rest of the app uses (`--nc-background`, `--nc-foreground`, `--nc-primary`) instead
 *  of hand-eyeballed hex restatements that silently drift from the theme. xterm needs
 *  concrete color strings (not CSS `var()`), so the resolved token values are read at
 *  spawn time; the selection is the primary at 30% via `color-mix` (already used
 *  elsewhere in the app's stylesheet). Any token that can't be read falls back to the
 *  shipped hex, so a stylesheet-less host still gets a valid, parseable theme. */
export function resolveTerminalTheme(): TerminalTheme {
  const background = readCssToken('--nc-background');
  const foreground = readCssToken('--nc-foreground');
  const primary = readCssToken('--nc-primary');
  return {
    background: background || TERMINAL_THEME_FALLBACK.background,
    foreground: foreground || TERMINAL_THEME_FALLBACK.foreground,
    cursor: primary || TERMINAL_THEME_FALLBACK.cursor,
    selectionBackground: primary
      ? `color-mix(in oklch, ${primary} 30%, transparent)`
      : TERMINAL_THEME_FALLBACK.selectionBackground,
  };
}

/** The last segment of a cwd — a tab's short label. Strips the Windows verbatim
 *  prefix and splits on BOTH separators, so `\\?\X:\dev\nightcore` and
 *  `/home/x/nightcore` both label as `nightcore`. Thin alias over the shared
 *  {@link pathLeaf} so the terminal keeps its domain-named helper. */
export function terminalLabel(cwd: string): string {
  return pathLeaf(cwd);
}

/** The display name for a session or restored tab (decision 5): the user's manual
 *  title when set, else the cwd leaf — so an un-renamed / legacy session labels
 *  exactly as before. Accepts any descriptor carrying a nullable `title` + `cwd`
 *  (both {@link TerminalSessionInfo} and `PersistedTerminalInfo` qualify). A
 *  blank/whitespace title is treated as unset (the server normalizes to `null`, but
 *  the optimistic local update guards here too). */
export function displayTitle(session: { title: string | null; cwd: string }): string {
  const title = session.title?.trim();
  return title !== undefined && title !== '' ? title : terminalLabel(session.cwd);
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

/** One-line hint shown under a CONFINED tab's identity chrome (decision 1): the
 *  Seatbelt profile denies writes to $HOME, so shell-startup housekeeping (history,
 *  oh-my-zsh cache) can print `Operation not permitted` on a first run — reassure the
 *  user that's expected. Copy kept consistent with the picker's confined description
 *  ("writes limited to this folder"). Only the confined pane shows it. */
export function confinedNoiseHint(): string {
  return 'Writes outside this folder are blocked — some shell-startup noise is normal.';
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

/** The "ungoverned session" marker label (decision 3): a task-linked or Claude-launched
 *  terminal runs as the user, OUTSIDE the agent guardrails. Shown in the tab + pane
 *  identity chrome. */
export function ungovernedLabel(): string {
  return 'Ungoverned';
}

/** The hover/title explanation behind {@link ungovernedLabel} (decision 3, verbatim). */
export function ungovernedTitle(): string {
  return 'Runs as you, outside the gates, flight-recorder, and gauntlet. Terminal work can never mark a task verified.';
}

/** The linkage chip label (decision 2): the task this terminal is linked to. */
export function linkedTaskChipLabel(title: string): string {
  return `Task: ${title}`;
}

/** The unread-output badge text (decision 6c): the raw count, clamped so a busy
 *  background tab/pane shows `99+` rather than an ever-widening pill. Shared by the
 *  tab strip and the grid pane header so both badge identically. */
export function unreadBadge(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** Accessible label for the unread badge. */
export function unreadBadgeLabel(count: number): string {
  return `${count} unread output ${count === 1 ? 'batch' : 'batches'}`;
}

/** Accessible label + tooltip for the LOUD needs-attention badge (T11): a completion
 *  or awaiting-input signal (OSC 9/99/777 or BEL) fired while the tab/pane was
 *  off-screen. Shared by the tab strip and the grid pane so both read identically. */
export function attentionBadgeLabel(): string {
  return 'Waiting for you — a command finished';
}

/** The broadcast-input toggle's visible + accessible label (round-2 PR B, § B.3):
 *  the grid "type once, run everywhere" arm control. Loud on purpose — broadcasting
 *  keystrokes to N shells is a footgun the armed state must never hide. */
export function broadcastToggleLabel(armed: boolean): string {
  return armed ? 'Broadcasting to all panes' : 'Broadcast input';
}

/** The broadcast toggle's hover explanation (round-2 PR B). `eligible` is false with
 *  fewer than two visible grid panes — there is nothing to broadcast to. */
export function broadcastToggleTitle(armed: boolean, eligible: boolean): string {
  if (!eligible && !armed) return 'Broadcast needs two or more visible panes in grid view.';
  return armed
    ? 'Every keystroke is being sent to all visible panes — click to stop.'
    : 'Send every keystroke to all visible panes at once.';
}

/** The per-pane "receiving broadcast" chip text (round-2 PR B, § B.3): a short, LOUD
 *  badge shown on EVERY visible pane while broadcast is armed, so an accidental
 *  broadcast is impossible to miss. */
export function broadcastBadge(): string {
  return 'BCAST';
}

/** Accessible label for the per-pane broadcast indicator (badge + ring). */
export function broadcastBadgeLabel(): string {
  return 'Receiving broadcast input';
}

/** The drop-hint overlay copy (round-2 PR C, § C.2): shown on the pane under a dragged
 *  file so the target is unmistakable. Dropping types the file's shell-escaped absolute
 *  path at the prompt — the user then presses Enter. */
export function dropHintLabel(): string {
  return 'Drop to paste path';
}

/** Accessible label for the drop-target overlay (the pane under the dragged file). */
export function dropHintAriaLabel(): string {
  return 'Drop a file here to type its path';
}

/** Count-driven grid column count (decision 1, PR 2): 1→1, 2→2, ≤4→2, ≤6→3, ≤9→3,
 *  else (up to the 12-session cap) →4. Rows follow from `ceil(n / gridColumns(n))`.
 *  No free-form spans in v1. Pure + unit-tested. `n<=1` yields 1 (an empty grid
 *  renders no cells anyway). */
export function gridColumns(n: number): number {
  if (n <= 2) return n <= 1 ? 1 : 2;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
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
