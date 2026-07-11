/** Top-level Insight component: renders the CONFIGURE / RUNNING / RESULTS
 *  lifecycle and the finding detail panel from the `useInsightView` model. */
import {
  BulkConvertBar,
  Button,
  ChevronLeftIcon,
  EmptyState,
  FolderIcon,
  HistoryIcon,
  InsightIcon,
  IssueMapExportButton,
  Menu,
  RetryIcon,
  RunLifecycleShell,
  RunProgress,
  RunUsageLine,
  StopIcon,
} from '@/components/ui';

import { CategoryTabs } from '../CategoryTabs';
import { FindingDetailPanel } from '../FindingDetailPanel';
import { FindingGrid } from '../FindingGrid';
import { RunControls } from '../RunControls';
import { useInsightView } from './InsightView.hooks';
import type { InsightViewProps } from './InsightView.types';

/** The Insight surface as a three-screen lifecycle (CONFIGURE / RUNNING /
 *  RESULTS) wrapped in the shared `RunLifecycleShell`, driven by `stream.status`
 *  plus an explicit "New run" reconfigure override. */
export function InsightView(props: InsightViewProps) {
  const view = useInsightView(props);

  if (!view.hasProject) {
    return (
      <EmptyState
        icon={<FolderIcon size={32} />}
        title="No active project"
        description="Open a project to analyze its codebase. Insight runs over the active project's repo."
      />
    );
  }

  const title = (
    <span className="flex items-center gap-2">
      <InsightIcon size={16} className="text-primary" />
      Insight
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

  // Collapsed-config bar: read-only while running, click-to-reconfigure otherwise,
  // with the persisted run receipt (cost/tokens/duration/model) on RESULTS (T8).
  const summary = (
    <div className="flex items-center justify-between gap-3">
      {view.stream.status === 'running' ? (
        <span>{view.summary}</span>
      ) : (
        <button
          type="button"
          onClick={view.startNewRun}
          className="min-w-0 truncate text-left transition-colors hover:text-foreground"
        >
          {view.summary}
          {/* Append to the accessible name without an aria-label, which would
              clobber the visible config text screen-reader users still want read. */}
          <span className="sr-only"> — reconfigure run</span>
        </button>
      )}
      {view.phase === 'results' && (
        <RunUsageLine
          model={view.stream.model}
          costUsd={view.stream.costUsd}
          usage={view.stream.usage}
          durationMs={view.stream.durationMs}
          className="shrink-0"
        />
      )}
    </div>
  );

  return (
    <>
      <RunLifecycleShell
        title={title}
        subtitle={view.projectName ?? 'Codebase analysis'}
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
              onAnalyze={view.onAnalyze}
            />
          </div>
        )}

        {view.phase === 'running' && (
          <div className="flex min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[820px] px-6 py-7">
              {view.peekCategory === null ? (
                <>
                  <RunProgress
                    status={view.stream.status}
                    categories={view.progressCategories}
                    categoryState={view.stream.categoryState}
                    findingCounts={view.findingCounts}
                    unitLabel="categories"
                    costUsd={view.stream.costUsd}
                    usage={view.stream.usage}
                    durationMs={view.stream.durationMs}
                    onOpenCategory={view.onOpenCategory}
                  />
                  <div className="mt-5 flex justify-end">
                    <Button variant="danger" onClick={view.onCancel}>
                      <StopIcon size={15} />
                      Cancel scan
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={view.clearPeek}
                    className="inline-flex w-fit items-center gap-1 font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronLeftIcon size={13} />
                    Back to progress
                  </button>
                  <span className="text-[13px] font-semibold text-foreground">
                    {view.peekLabel}
                  </span>
                  <FindingGrid
                    findings={view.peekFindings}
                    skeletonCount={0}
                    emptyMessage="No findings in this category yet."
                    onOpen={view.openFinding}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {view.phase === 'results' && (
          <div className="flex min-h-0 flex-1 flex-col">
            {view.stream.status === 'failed' &&
              (view.stream.failureReason === 'aborted' ? (
                // A user cancel isn't a failure — show a neutral notice, not the
                // destructive banner.
                <div className="px-6 pt-5">
                  <div className="rounded-[10px] border border-border bg-white/[0.02] px-4 py-3 text-[12.5px] text-muted-foreground">
                    Analysis cancelled. Any findings gathered before you stopped are
                    shown below.
                  </div>
                </div>
              ) : (
                <div className="px-6 pt-5">
                  <div className="rounded-[10px] border border-destructive/40 bg-destructive/[0.08] px-4 py-3 text-[12.5px] text-destructive">
                    {view.stream.error ?? 'Analysis failed.'}
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
                  <IssueMapExportButton scanKind="insight" runId={view.stream.runId} />
                }
              />
            )}

            <CategoryTabs
              tabs={view.tabs}
              active={view.activeTab}
              onSelect={view.setActiveTab}
            />

            <FindingGrid
              findings={view.gridFindings}
              skeletonCount={view.skeletonCount}
              emptyMessage={view.emptyMessage}
              onOpen={view.openFinding}
            />
          </div>
        )}
      </RunLifecycleShell>

      <FindingDetailPanel
        open={view.selected !== null}
        finding={view.selected}
        pending={view.pending}
        onClose={view.closeFinding}
        onConvert={view.onConvert}
        onDismiss={view.onDismiss}
        onRestore={view.onRestore}
        onGotoBoard={view.onGotoBoard}
      />
    </>
  );
}
