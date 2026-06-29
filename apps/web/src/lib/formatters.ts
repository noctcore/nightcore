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
