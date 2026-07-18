/** The global History view: one cross-family list of every Insight / Scorecard /
 *  Harness run for the active project, newest first. A row click opens that run
 *  on its owning stage (Understand / Enforce). Renders purely from the
 *  {@link useAllScanRuns} merge hook — a thin shell over {@link HistoryList}. */
import { Button, HistoryIcon, RetryIcon, Spinner } from '@/components/ui';

import { useAllScanRuns } from './HistoryView.hooks';
import { HistoryList } from './HistoryView.parts';
import type { HistoryViewProps } from './HistoryView.types';

export function HistoryView({ projectPath, onOpenRun }: HistoryViewProps) {
  const { runs, loading, error, refresh } = useAllScanRuns(projectPath);

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

      <HistoryList runs={runs} loading={loading} error={error} onOpenRun={onOpenRun} />
    </div>
  );
}
