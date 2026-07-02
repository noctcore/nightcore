/** Top-level PR Review component: renders the CONFIGURE / RUNNING / RESULTS
 *  lifecycle, the finding detail panel, and the human-gated post-review toolbar +
 *  ConfirmDialog from the `usePrReviewView` model. */
import {
  Button,
  ConfirmDialog,
  EmptyState,
  FolderIcon,
  GithubIcon,
  HistoryIcon,
  Menu,
  MoveIcon,
  RetryIcon,
  RunLifecycleShell,
  RunProgress,
  StopIcon,
} from '@/components/ui';

import { FindingDetailPanel } from '../FindingDetailPanel';
import { VERDICT_META } from '../prreview.constants';
import type { ReviewVerdict } from '../prreview.types';
import { ReviewFindings } from '../ReviewFindings';
import { RunControls } from '../RunControls';
import { usePrReviewView } from './PrReviewView.hooks';
import type { PrReviewViewProps } from './PrReviewView.types';

/** The three post-review verdict buttons, in display order. */
const VERDICTS: ReviewVerdict[] = ['approve', 'request-changes', 'comment'];

/** The PR Review surface as a three-screen lifecycle (CONFIGURE / RUNNING /
 *  RESULTS) wrapped in the shared `RunLifecycleShell`, driven by `stream.status`
 *  plus an explicit "New run" reconfigure override. */
export function PrReviewView(props: PrReviewViewProps) {
  const view = usePrReviewView(props);

  if (!view.hasProject) {
    return (
      <EmptyState
        icon={<FolderIcon size={32} />}
        title="No active project"
        description="Open a project to review its pull requests. PR Review reviews a PR of the active project's repo."
      />
    );
  }

  const title = (
    <span className="flex items-center gap-2">
      <GithubIcon size={16} />
      PR Review
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

  const verdictMeta = view.postVerdict !== null ? VERDICT_META[view.postVerdict] : null;

  return (
    <>
      <RunLifecycleShell
        title={title}
        subtitle={view.projectName ?? 'Pull-request review'}
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
              onReview={view.onReview}
            />
          </div>
        )}

        {view.phase === 'running' && (
          <div className="flex min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[820px] px-6 py-7">
              <RunProgress
                status={view.stream.status}
                categories={view.progressCategories}
                categoryState={view.stream.lensState}
                findingCounts={view.findingCounts}
                unitLabel="lenses"
                costUsd={view.stream.costUsd}
                usage={view.stream.usage}
                durationMs={view.stream.durationMs}
              />
              <div className="mt-5 flex justify-end">
                <Button variant="danger" onClick={view.onCancel}>
                  <StopIcon size={15} />
                  Cancel review
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
                    Review cancelled. Any findings gathered before you stopped are
                    shown below.
                  </div>
                </div>
              ) : (
                <div className="px-6 pt-5">
                  <div className="rounded-[10px] border border-destructive/40 bg-destructive/[0.08] px-4 py-3 text-[12.5px] text-destructive">
                    {view.stream.error ?? 'Review failed.'}
                  </div>
                </div>
              ))}

            {view.stream.status === 'completed' && (
              <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
                <Button
                  aria-busy={view.bulkConverting}
                  aria-disabled={view.openCount === 0 || view.bulkConverting}
                  onClick={view.convertAll}
                  variant="secondary"
                  className={
                    view.openCount === 0 || view.bulkConverting
                      ? 'cursor-not-allowed opacity-40'
                      : undefined
                  }
                >
                  <MoveIcon size={15} />
                  {view.bulkConverting
                    ? `Converting… ${view.bulkProgress.done}/${view.bulkProgress.total}`
                    : `Convert all to tasks (${view.openCount})`}
                </Button>
                {view.bulkError !== null && (
                  <span className="text-[12px] text-destructive">
                    {view.bulkError}
                  </span>
                )}

                {/* Post-review toolbar: the three human-gated verdicts. Each opens
                    the ConfirmDialog — none auto-fires. */}
                <div className="ml-auto flex items-center gap-2">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {view.selectedCount} selected
                  </span>
                  {VERDICTS.map((verdict) => {
                    const meta = VERDICT_META[verdict];
                    const Icon = meta.icon;
                    return (
                      <Button
                        key={verdict}
                        variant={meta.destructive ? 'danger' : 'secondary'}
                        disabled={!view.canPost}
                        onClick={() => view.requestPost(verdict)}
                      >
                        <Icon size={15} />
                        {meta.label}
                      </Button>
                    );
                  })}
                </div>

                <span role="status" aria-live="polite" className="sr-only">
                  {view.bulkStatusMessage}
                </span>
              </div>
            )}

            <ReviewFindings
              findings={view.gridFindings}
              skeletonCount={view.skeletonCount}
              emptyMessage={view.emptyMessage}
              selection={view.selection}
              onToggleSelect={view.onToggleSelect}
              onOpen={view.openFinding}
            />
          </div>
        )}
      </RunLifecycleShell>

      {view.selected !== null && (
        <FindingDetailPanel
          finding={view.selected}
          pending={view.pending}
          onClose={view.closeFinding}
          onConvert={view.onConvert}
          onDismiss={view.onDismiss}
          onRestore={view.onRestore}
          onGotoBoard={view.onGotoBoard}
        />
      )}

      {view.postVerdict !== null && verdictMeta !== null && (
        <ConfirmDialog
          title={verdictMeta.confirmTitle}
          confirmLabel={verdictMeta.confirmLabel}
          destructive={verdictMeta.destructive}
          busy={view.posting}
          onConfirm={view.confirmPost}
          onCancel={view.cancelPost}
          message={
            <div className="flex flex-col gap-2">
              <span>
                Post{' '}
                <span className="font-semibold text-foreground">
                  {verdictMeta.label.toLowerCase()}
                </span>{' '}
                on{' '}
                <span className="font-mono text-foreground">
                  PR #{view.stream.prNumber}
                </span>{' '}
                with{' '}
                <span className="font-semibold text-foreground">
                  {view.selectedCount}
                </span>{' '}
                selected {view.selectedCount === 1 ? 'finding' : 'findings'}
                {view.selectedInlineCount > 0
                  ? ` (${view.selectedInlineCount} inline ${
                      view.selectedInlineCount === 1 ? 'comment' : 'comments'
                    })`
                  : ''}
                ?
              </span>
              {view.postError !== null && (
                <span
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/[0.1] px-3 py-2 text-[12.5px] text-destructive"
                >
                  {view.postError}
                </span>
              )}
            </div>
          }
        />
      )}
    </>
  );
}
