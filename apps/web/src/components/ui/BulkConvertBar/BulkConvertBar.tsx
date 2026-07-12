/** The shared "convert every open finding → tasks" results-toolbar bar. Hoisted
 *  verbatim from the Insight results screen (the shipped idiom) so its scan
 *  siblings — Scorecard, Harness (conventions + proposals) — render the exact
 *  same affordance: the same left-aligned button placement, the in-flight
 *  `Converting… k/N` progress, the inline partial-failure summary, and the
 *  polite aria-live announcement. Purely presentational — the state lives in the
 *  owning view's `useBulkConvert` machine. */
import { Button } from '../Button';
import { MoveIcon } from '../icons';
import type { BulkConvertBarProps } from './BulkConvertBar.types';

export function BulkConvertBar({
  count,
  converting,
  progress,
  statusMessage,
  error,
  onConvertAll,
  trailing,
}: BulkConvertBarProps) {
  const inert = count === 0 || converting;
  return (
    <div className="flex items-center gap-3 border-b border-border px-6 py-3">
      <Button
        // aria-busy + aria-disabled (not the `disabled` attribute) keep the
        // trigger focusable through the conversion so focus isn't dropped to
        // <body> when it becomes inert; `onConvertAll` is a no-op when inert.
        aria-busy={converting}
        aria-disabled={inert}
        onClick={onConvertAll}
        className={inert ? 'cursor-not-allowed opacity-40' : undefined}
      >
        <MoveIcon size={15} />
        {converting
          ? `Converting… ${progress.done}/${progress.total}`
          : `Convert all to tasks (${count})`}
      </Button>
      {error !== null && (
        <span className="text-xs-flat text-destructive">{error}</span>
      )}
      {/* Announce convert-all progress + completion to assistive tech. */}
      <span role="status" aria-live="polite" className="sr-only">
        {statusMessage}
      </span>
      {/* Trailing sibling action (e.g. Export to GitHub) — same bar, right edge. */}
      {trailing !== undefined && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}
