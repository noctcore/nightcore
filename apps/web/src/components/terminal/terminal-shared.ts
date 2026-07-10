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
