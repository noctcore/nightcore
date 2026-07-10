import {
  BulkConvertBar,
  Button,
  EmptyState,
  FolderIcon,
  HistoryIcon,
  IssueMapExportButton,
  Menu,
  PerfIcon,
  RetryIcon,
  RunLifecycleShell,
  RunProgress,
  StopIcon,
} from '@/components/ui';

import { DimensionGrid } from '../DimensionGrid';
import { ReadingDetailPanel } from '../ReadingDetailPanel';
import { RunControls } from '../RunControls';
import { useScorecardView } from './ScorecardView.hooks';
import type { ScorecardViewProps } from './ScorecardView.types';

/** The Readiness Scorecard surface as a three-screen lifecycle (CONFIGURE / RUNNING
 *  / RESULTS) wrapped in the shared `RunLifecycleShell`, driven by `stream.status`
 *  plus an explicit "New run" reconfigure override. The Profile twin of InsightView. */
export function ScorecardView(props: ScorecardViewProps) {
  const view = useScorecardView(props);

  if (!view.hasProject) {
    return (
      <EmptyState
        icon={<FolderIcon size={32} />}
        title="No active project"
        description="Open a project to grade its production readiness. The Scorecard runs over the active project's repo."
      />
    );
  }

  const title = (
    <span className="flex items-center gap-2">
      <PerfIcon size={16} className="text-primary" />
      Scorecard
    </span>
  );

  const actions = (
    <>
      {view.hasHistory && (
        <Menu
          label="Run history"
          items={view.runHistory}
          align="right"
          trigger={
            <Button variant="ghost">
              <HistoryIcon size={14} />
              History
            </Button>
          }
        />
      )}
      {view.phase === 'results' && (
        <Button variant="ghost" onClick={view.startNewRun}>
          <RetryIcon size={14} />
          New run
        </Button>
      )}
    </>
  );

  const summary =
    view.stream.status === 'running' ? (
      <span>{view.summary}</span>
    ) : (
      <button
        type="button"
        onClick={view.startNewRun}
        className="transition-colors hover:text-foreground"
      >
        {view.summary}
        <span className="sr-only"> — reconfigure run</span>
      </button>
    );

  return (
    <>
      <RunLifecycleShell
        title={title}
        subtitle={view.projectName ?? 'Production readiness'}
        phase={view.phase}
        summary={summary}
        actions={actions}
      >
        {view.phase === 'configure' && (
          <div className="flex min-h-0 flex-1 flex-col">
            {view.startError !== null && (
              <p className="border-b border-destructive/40 bg-destructive/[0.1] px-6 py-2 text-[12.5px] text-destructive">
                {view.startError}
              </p>
            )}
            <RunControls
              config={view.config}
              isStarting={view.isStarting}
              onGrade={view.onGrade}
            />
          </div>
        )}

        {view.phase === 'running' && (
          <div className="flex min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[820px] px-6 py-7">
              <RunProgress
                status={view.stream.status}
                categories={view.progressCategories}
                categoryState={view.stream.dimensionState}
                findingCounts={view.findingCounts}
                unitLabel="dimensions"
                costUsd={view.stream.costUsd}
                usage={view.stream.usage}
                durationMs={view.stream.durationMs}
              />
              <div className="mt-5 flex justify-end">
                <Button variant="danger" onClick={view.onCancel}>
                  <StopIcon size={15} />
                  Cancel grading
                </Button>
              </div>
            </div>
          </div>
        )}

        {view.phase === 'results' && (
          <div className="flex min-h-0 flex-1 flex-col">
            {view.stream.status === 'failed' &&
              (view.stream.failureReason === 'aborted' ? (
                <div className="px-6 pt-5">
                  <div className="rounded-[10px] border border-border bg-white/[0.02] px-4 py-3 text-[12.5px] text-muted-foreground">
                    Grading cancelled. Any dimensions graded before you stopped are
                    shown below.
                  </div>
                </div>
              ) : (
                <div className="px-6 pt-5">
                  <div className="rounded-[10px] border border-destructive/40 bg-destructive/[0.08] px-4 py-3 text-[12.5px] text-destructive">
                    {view.stream.error ?? 'Grading failed.'}
                  </div>
                </div>
              ))}

            {view.stream.status === 'completed' && (
              <BulkConvertBar
                count={view.openCount}
                converting={view.bulkConverting}
                progress={view.bulkProgress}
                statusMessage={view.bulkStatusMessage}
                error={view.bulkError}
                onConvertAll={view.convertAll}
                trailing={
                  <IssueMapExportButton scanKind="scorecard" runId={view.stream.runId} />
                }
              />
            )}

            <DimensionGrid
              rows={view.rows}
              emptyMessage={view.emptyMessage}
              onOpen={view.openReading}
            />
          </div>
        )}
      </RunLifecycleShell>

      <ReadingDetailPanel
        open={view.selected !== null}
        reading={view.selected}
        pending={view.pending}
        onClose={view.closeReading}
        onHarden={view.onHarden}
        onGotoBoard={view.onGotoBoard}
      />
    </>
  );
}
