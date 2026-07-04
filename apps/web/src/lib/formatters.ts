/** Shared formatting helpers for grounded `file:line` locations rendered across
 *  the Insight, Harness, and Scorecard surfaces. Kept feature-agnostic so the
 *  finding, convention-evidence, and reading views all project their grounded
 *  anchors identically (previously each feature carried its own copy). */

/** The minimal grounded-location shape every surface normalizes into: a
 *  repo-relative file with an optional 1-based line range and an optional symbol. */
export interface LocationLike {
  file: string;
  startLine: number | null;
  endLine: number | null;
  symbol?: string | null;
}

/**
 * Render a grounded location as `file:line`, `file:start-end`, or just `file`
 * when no line is known. Returns `null` for a missing location so callers can
 * omit the row entirely. With `withSymbol`, a present symbol is appended as
 * ` · symbol` — the detail panels show it; the dense card/grid labels do not.
 */
export function formatLocation(
  loc: LocationLike | null,
  opts?: { withSymbol?: boolean },
): string | null {
  if (loc === null) return null;
  if (loc.startLine !== null) {
    const range =
      loc.endLine !== null && loc.endLine !== loc.startLine
        ? `${loc.startLine}-${loc.endLine}`
        : String(loc.startLine);
    const symbol =
      (opts?.withSymbol ?? false) && loc.symbol != null ? ` · ${loc.symbol}` : '';
    return `${loc.file}:${range}${symbol}`;
  }
  return loc.file;
}

/** Format a USD amount as a two-decimal dollar string (e.g. `$0.42`). Shared by
 *  the board cost badges and the RUNNING-screen progress readout. */
export function formatCostUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Format a millisecond elapsed span as `m:ss`, clamping negatives to zero.
 * Seconds are always zero-padded to two digits; minutes are padded only when
 * `padMinutes` is set — the board's live card timer shows `01:05`, while the
 * progress readout shows `1:05`.
 */
export function formatElapsed(ms: number, opts?: { padMinutes?: boolean }): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const mm = (opts?.padMinutes ?? false) ? String(minutes).padStart(2, '0') : String(minutes);
  return `${mm}:${String(seconds).padStart(2, '0')}`;
}
