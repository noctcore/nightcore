/** Presentational parts for the History view — the filter bar, a newest-first run
 *  list with per-row delete, the empty state, the non-blocking warning row, and the
 *  retention (prune-transparency) footer. Split out so stories/tests can drive the
 *  rendered list directly with fixtures (no bridge). Pure: no state, no data
 *  fetching — the routed {@link HistoryView} feeds it the merged summary. */
import {
  Badge,
  EmptyState,
  HistoryIcon,
  IconButton,
  Skeleton,
  StatusDot,
  TrashIcon,
} from '@/components/ui';
import { formatRelativeTime, formatRunReceipt } from '@/lib/formatters';

import { useHistoryVirtualizer } from './HistoryView.hooks';
import type {
  HistoryFamilyFilter,
  HistoryFilterBarProps,
  HistoryListProps,
  HistoryStatusFilter,
  ScanFamily,
  ScanRunSummary,
} from './HistoryView.types';
import { narrowedLabel, retentionNotice } from './HistoryView.utils';

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

/** The filter options, declared once so the bar and its tests agree on order. */
const FAMILY_FILTERS: readonly HistoryFamilyFilter[] = [
  'all',
  'insight',
  'scorecard',
  'harness',
];
const STATUS_FILTERS: readonly HistoryStatusFilter[] = ['all', 'running', 'completed', 'failed'];

/** One filter chip — a real `radio` so each group is keyboard-navigable and screen
 *  readers announce the selection, rather than a pressed-looking plain button. */
function FilterChip({
  selected,
  label,
  count,
  onSelect,
}: {
  selected: boolean;
  label: string;
  count?: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      // Explicit name: the trailing count is decorative, and folding it into the
      // accessible name would make every query a substring guess.
      aria-label={label}
      onClick={onSelect}
      className={`rounded-full px-2.5 py-1 text-2xs font-medium transition-colors ${
        selected
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'
      }`}
    >
      {label}
      {count !== undefined && (
        <span aria-hidden className="ml-1 tabular-nums opacity-60">
          {count}
        </span>
      )}
    </button>
  );
}

/** The kind + status filter chips. Radio groups rather than dropdowns: there are only
 *  three families and three statuses, so the entire filter state stays legible at a
 *  glance and is one click wide. The kind chips carry loaded counts so a chip says
 *  what it would reveal instead of being a blind toggle. */
export function HistoryFilterBar({
  family,
  status,
  onFamilyChange,
  onStatusChange,
  counts,
}: HistoryFilterBarProps) {
  const total = counts.insight + counts.scorecard + counts.harness;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-4 py-2">
      <div role="radiogroup" aria-label="Filter by kind" className="flex items-center gap-1">
        {FAMILY_FILTERS.map((value) => (
          <FilterChip
            key={value}
            selected={family === value}
            label={value === 'all' ? 'All kinds' : FAMILY_LABEL[value]}
            count={value === 'all' ? total : counts[value]}
            onSelect={() => onFamilyChange(value)}
          />
        ))}
      </div>
      <div role="radiogroup" aria-label="Filter by status" className="flex items-center gap-1">
        {STATUS_FILTERS.map((value) => (
          <FilterChip
            key={value}
            selected={status === value}
            label={value === 'all' ? 'Any status' : statusMeta(value).label}
            onSelect={() => onStatusChange(value)}
          />
        ))}
      </div>
    </div>
  );
}

/** One run row: the family badge, the derived title, the model it ran on, the
 *  persisted receipt (cost + duration), its status, when it ran (with the absolute
 *  timestamp on hover), and a delete action. The row body is the open button; delete
 *  is a sibling, never nested inside it, so one click can't trigger both. */
function HistoryRow({
  run,
  onOpen,
  onDelete,
}: {
  run: ScanRunSummary;
  onOpen: () => void;
  onDelete?: () => void;
}) {
  const status = statusMeta(run.status);
  const when = formatRelativeTime(run.createdAt);
  // The persisted run receipt (approximate cost + duration), surfaced on the row (T8).
  const receipt = formatRunReceipt(run.costUsd, run.durationMs);
  return (
    <div className="group flex w-full items-center transition-colors hover:bg-white/[0.03]">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
      >
        <Badge>{FAMILY_LABEL[run.family]}</Badge>
        <span className="min-w-0 flex-1 truncate text-xs-plus2 text-foreground" title={run.title}>
          {run.title}
        </span>
        {run.model.length > 0 && (
          <span
            className="hidden max-w-[11rem] shrink-0 truncate font-mono text-2xs text-muted-foreground/70 sm:inline-block"
            title={`Model: ${run.model}`}
          >
            {run.model}
          </span>
        )}
        <span className="shrink-0 tabular-nums font-mono text-2xs text-muted-foreground/80">
          {receipt}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs text-muted-foreground">
          <StatusDot colorClass={status.dot} pulse={run.status === 'running'} />
          {status.label}
        </span>
        {when !== '' && (
          <span
            className="shrink-0 tabular-nums font-mono text-2xs text-muted-foreground/80"
            title={new Date(run.createdAt).toLocaleString()}
          >
            {when}
          </span>
        )}
      </button>
      {onDelete !== undefined && (
        <span className="mr-2 shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <IconButton label={`Delete this ${FAMILY_LABEL[run.family]} run`} onClick={onDelete}>
            <TrashIcon size={14} />
          </IconButton>
        </span>
      )}
    </div>
  );
}

/** First-load placeholder: skeleton rows shaped like {@link HistoryRow} (badge
 *  block + title line + two trailing meta blocks) so the list doesn't jump when
 *  the real rows resolve. The container owns the loading announcement; the
 *  Skeletons themselves are `aria-hidden`. */
function HistoryLoadingRows() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading history"
      className="flex min-h-0 flex-1 flex-col"
    >
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="flex w-full items-center gap-3 border-b border-border px-4 py-3"
        >
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="ml-auto h-3 w-16" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

/** The newest-first run list with its empty/loading/warning treatments plus the
 *  retention footer. The populated list is virtualized (`useHistoryVirtualizer`) so an
 *  unbounded run history only mounts the visible rows — mirroring the board column. */
export function HistoryList({
  runs,
  loading,
  error,
  onOpenRun,
  onDeleteRun,
  retention,
  totalRuns,
}: HistoryListProps) {
  const showEmpty = !loading && runs.length === 0 && error === null;
  const { setScrollRef, virtualizer } = useHistoryVirtualizer(runs);
  // Non-null only while a filter is hiding something, so an emptied-by-filter list
  // never reads as "you have no history".
  const narrowed = narrowedLabel(runs.length, totalRuns ?? runs.length);
  const filtered = (totalRuns ?? runs.length) > runs.length;

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
          title={filtered ? 'No runs match these filters' : 'No scan runs yet'}
          description={
            filtered
              ? 'Every loaded run is filtered out — widen the kind or status filter to see them.'
              : 'Start one from Find & Grade, Propose, or Conventions — every run shows up here.'
          }
        />
      ) : runs.length === 0 && loading ? (
        <HistoryLoadingRows />
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
                  <HistoryRow
                    run={run}
                    onOpen={() => onOpenRun(run.family, run.id)}
                    onDelete={
                      onDeleteRun === undefined
                        ? undefined
                        : () => onDeleteRun(run.family, run.id)
                    }
                  />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Prune transparency (#407): the core keeps a bounded number of runs per kind
          and drops the oldest SETTLED ones beyond it. That happened silently, so a
          user whose old run "vanished" had no way to know it was policy, not a bug. */}
      <p className="flex flex-wrap items-center gap-x-2 border-t border-border px-4 py-2 text-2xs text-muted-foreground/80">
        {narrowed !== null && (
          <span className="tabular-nums text-muted-foreground">{narrowed}</span>
        )}
        <span>{retentionNotice(retention)}</span>
      </p>
    </div>
  );
}
