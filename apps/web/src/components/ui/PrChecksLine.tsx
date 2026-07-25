/** Shared PR-status line fragments, hoisted so the board's `PrStatusCard` and the
 *  PR Review workspace's `PrStatusBlock` render the drifting checks + refreshed
 *  rows from ONE place (the pure gh-vocabulary mappers already live in
 *  `@/lib/pr-status`). Both fragments keep `font-mono` + `tabular-nums` so the
 *  digits never jitter; each tint lights only when its count is non-zero. */
import { formatRefreshedAt } from '@/lib/pr-status';

/** The `N passed · N failed · N pending` check-run line. Each segment tints its
 *  semantic tone only when the count is > 0 (a `0 passed` reads muted, not a
 *  false green). `label` prefixes the line ("Checks:"); `className` composes
 *  the size/tone the host wants onto the shared `font-mono tabular-nums` base. */
export function PrChecksLine({
  checks,
  label,
  className,
}: {
  checks: { passed: number; failed: number; pending: number };
  label?: string;
  className?: string;
}) {
  return (
    <p
      className={`font-mono tabular-nums text-muted-foreground${className !== undefined ? ` ${className}` : ''}`}
    >
      {label !== undefined && `${label} `}
      <span className={checks.passed > 0 ? 'text-success' : undefined}>
        {checks.passed} passed
      </span>
      {' · '}
      <span className={checks.failed > 0 ? 'text-destructive' : undefined}>
        {checks.failed} failed
      </span>
      {' · '}
      <span className={checks.pending > 0 ? 'text-warning' : undefined}>
        {checks.pending} pending
      </span>
    </p>
  );
}

/** The "Refreshed <time>" footer stamped from the web-side receive timestamp.
 *  `className` carries the host's margin (the board wants `mt-2`). */
export function RefreshedAtLine({
  refreshedAt,
  className,
}: {
  refreshedAt: number;
  className?: string;
}) {
  return (
    <p
      className={`font-mono tabular-nums text-3xs text-muted-foreground${className !== undefined ? ` ${className}` : ''}`}
    >
      Refreshed {formatRefreshedAt(refreshedAt)}
    </p>
  );
}
