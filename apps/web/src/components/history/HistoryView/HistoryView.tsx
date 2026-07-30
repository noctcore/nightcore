/** The global History view: one cross-family list of every Insight / Scorecard /
 *  Harness run for the active project, newest first. A row click opens that run
 *  on its owning stage (Understand / Enforce); a row can also be deleted, and the
 *  footer states the core's retention rule so a pruned run is never a mystery.
 *  Renders purely from the {@link useAllScanRuns} merge hook plus the derived filter
 *  state — a thin shell over {@link HistoryFilterBar} + {@link HistoryList}. */
import { Button, ConfirmDialog, HistoryIcon, RetryIcon, Spinner } from '@/components/ui';

import { useAllScanRuns, useHistoryDelete, useHistoryFilters } from './HistoryView.hooks';
import { HistoryFilterBar, HistoryList } from './HistoryView.parts';
import type { HistoryViewProps } from './HistoryView.types';
import { familyCounts } from './HistoryView.utils';

export function HistoryView({ projectPath, onOpenRun }: HistoryViewProps) {
  const { runs, loading, error, refresh, retention, deleteRun } = useAllScanRuns(projectPath);
  const filters = useHistoryFilters(runs);
  const remove = useHistoryDelete(runs, deleteRun);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="flex items-center gap-2 text-xs-plus2 font-medium text-foreground">
          <HistoryIcon size={16} className="text-primary" />
          History
        </span>
        <span className="flex-1 text-xs-flat text-muted-foreground">
          Every scan run for this project — click one to reopen it.
        </span>
        <Button variant="ghost" onClick={refresh} disabled={loading}>
          {loading ? <Spinner size={14} /> : <RetryIcon size={14} />}
          Refresh
        </Button>
      </div>

      <HistoryFilterBar
        family={filters.family}
        status={filters.status}
        onFamilyChange={filters.setFamily}
        onStatusChange={filters.setStatus}
        counts={familyCounts(runs)}
      />

      <HistoryList
        runs={filters.visible}
        loading={loading}
        error={error}
        onOpenRun={onOpenRun}
        onDeleteRun={remove.request}
        retention={retention}
        totalRuns={runs.length}
      />

      {/* Always mounted, toggled by `open` — the dialog animates in/out. Deleting a
          run unlinks it from disk, so it never happens on a bare click. */}
      <ConfirmDialog
        open={remove.pending !== null}
        title="Delete this run?"
        message={`“${remove.pending?.title ?? ''}” and its findings are removed from disk. This cannot be undone.`}
        confirmLabel="Delete run"
        destructive
        busy={remove.busy}
        onConfirm={remove.confirm}
        onCancel={remove.cancel}
      />
    </div>
  );
}
