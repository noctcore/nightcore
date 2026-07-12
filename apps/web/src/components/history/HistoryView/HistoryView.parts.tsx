/** Presentational parts for the History view — a plain newest-first run list,
 *  the empty state, and the non-blocking warning row. Split out so stories/tests
 *  can drive the rendered list directly with fixtures (no bridge). Pure: no state,
 *  no data fetching — the routed {@link HistoryView} feeds it the merged summary. */
import { Badge, EmptyState, HistoryIcon, StatusDot } from '@/components/ui';
import { formatRelativeTime, formatRunReceipt } from '@/lib/formatters';

import { useHistoryVirtualizer } from './HistoryView.hooks';
import type { HistoryListProps, ScanFamily, ScanRunSummary } from './HistoryView.types';

/** Family → badge label. */
const FAMILY_LABEL: Record<ScanFamily, string> = {
  insight: 'Insight',
  scorecard: 'Scorecard',
  harness: 'Harness',
};

/** Run status → dot color + label (the RunProgress status-chip idiom). Unknown
 *  statuses fall back to a neutral dot and the raw string. */
const STATUS_META: Record<string, { dot: string; label: string }> = {
  running: { dot: 'bg-primary', label: 'running' },
  completed: { dot: 'bg-success', label: 'complete' },
  failed: { dot: 'bg-destructive', label: 'failed' },
};

function statusMeta(status: string): { dot: string; label: string } {
  return STATUS_META[status] ?? { dot: 'bg-muted-foreground', label: status };
}

/** One run row — a full-width button that opens the run on its owning stage. */
function HistoryRow({
  run,
  onOpen,
}: {
  run: ScanRunSummary;
  onOpen: () => void;
}) {
  const status = statusMeta(run.status);
  const when = formatRelativeTime(run.createdAt);
  // The persisted run receipt (approximate cost + duration), surfaced on the row (T8).
  const receipt = formatRunReceipt(run.costUsd, run.durationMs);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03]"
    >
      <Badge>{FAMILY_LABEL[run.family]}</Badge>
      <span className="min-w-0 flex-1 truncate text-xs-plus2 text-foreground">{run.title}</span>
      <span
        className="shrink-0 tabular-nums font-mono text-2xs text-muted-foreground/80"
        title={run.model.length > 0 ? `Model: ${run.model}` : undefined}
      >
        {receipt}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs text-muted-foreground">
        <StatusDot colorClass={status.dot} pulse={run.status === 'running'} />
        {status.label}
      </span>
      {when !== '' && (
        <span className="shrink-0 tabular-nums font-mono text-2xs text-muted-foreground/80">
          {when}
        </span>
      )}
    </button>
  );
}

/** The newest-first run list with its empty/loading/warning treatments. The
 *  populated list is virtualized (`useHistoryVirtualizer`) so an unbounded run
 *  history only mounts the visible rows — mirroring the board column. */
export function HistoryList({ runs, loading, error, onOpenRun }: HistoryListProps) {
  const showEmpty = !loading && runs.length === 0 && error === null;
  const { setScrollRef, virtualizer } = useHistoryVirtualizer(runs);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error !== null && (
        <p
          role="status"
          className="border-b border-warning/40 bg-warning/[0.12] px-4 py-2 text-xs-flat text-warning"
        >
          {error}
        </p>
      )}

      {showEmpty ? (
        <EmptyState
          icon={<HistoryIcon size={32} />}
          title="No scan runs yet"
          description="Start one from Understand, Harden, or Enforce — every run shows up here."
        />
      ) : runs.length === 0 && loading ? (
        <div
          role="status"
          aria-busy="true"
          className="flex flex-1 items-center justify-center text-sm text-muted-foreground"
        >
          Loading history…
        </div>
      ) : (
        // Virtualized scroll container: only the visible rows mount. The inner
        // <ul> is sized to the full list height and each row is absolutely
        // positioned at its measured offset — so `divide-y` (which needs
        // in-flow siblings) is replaced by a per-row `border-b`.
        <div ref={setScrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <ul className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const run = runs[row.index];
              if (run === undefined) return null;
              return (
                <li
                  key={`${run.family}:${run.id}`}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full border-b border-border"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <HistoryRow run={run} onOpen={() => onOpenRun(run.family, run.id)} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
