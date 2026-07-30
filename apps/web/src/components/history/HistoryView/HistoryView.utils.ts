/** Pure helpers for the History view — the filter-chip counts and the retention
 *  transparency copy. No React, no bridge, no side effects (only sibling types), so
 *  the wording and the counting are unit-testable without mounting the list. */
import type { ScanFamily, ScanRunSummary } from './HistoryView.types';

/** Per-family loaded counts for the filter chips, so a chip can say what it would
 *  reveal rather than being a blind toggle. Families with no runs count 0 (never
 *  absent) so the caller never has to guard a lookup. */
export function familyCounts(runs: ScanRunSummary[]): Record<ScanFamily, number> {
  const counts: Record<ScanFamily, number> = { insight: 0, scorecard: 0, harness: 0 };
  for (const run of runs) counts[run.family] += 1;
  return counts;
}

/** The retention notice (#407 "prune transparency"). The core keeps at most
 *  `retention` runs PER KIND and prunes the oldest SETTLED ones beyond that — a
 *  running run is never evicted. History used to lose rows to that silently; this is
 *  the sentence that makes it visible. `null` (the cap not yet probed, or a failed
 *  probe) states the rule without inventing a number. */
export function retentionNotice(retention: number | null | undefined): string {
  const cap = retention ?? null;
  return cap === null
    ? 'History keeps a bounded number of runs per kind — older finished runs are pruned automatically.'
    : `History keeps the ${cap} most recent runs per kind — older finished runs are pruned automatically (a running one is never pruned).`;
}

/** `Showing 3 of 12` — the narrowed-list line, so a filtered History never reads as
 *  an empty one. Returns `null` when nothing is hidden (no line to render). */
export function narrowedLabel(visible: number, total: number): string | null {
  return visible < total ? `Showing ${visible} of ${total}` : null;
}
