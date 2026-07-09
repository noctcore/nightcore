/** The Issue Triage surface: a two-pane master/detail — the left pane lists the
 *  project's open GitHub issues, the right pane reads the selected issue (untrusted
 *  markdown), validates it against the codebase, shows the verdict, and offers the two
 *  human-gated actions (post as comment / convert to task). Composes the feature's
 *  sub-components from the single `useIssueTriageView` model. */
import { BugIcon, EmptyState, FolderIcon } from '@/components/ui';

import { ConvertToTaskDialog } from '../ConvertToTaskDialog';
import { IssueDetailPanel } from '../IssueDetailPanel';
import { IssueList } from '../IssueList';
import { PostCommentDialog } from '../PostCommentDialog';
import { ResultsPanel } from '../ResultsPanel';
import { ValidateControls } from '../ValidateControls';
import { useIssueTriageView } from './IssueTriageView.hooks';
import type { IssueTriageViewProps } from './IssueTriageView.types';

export function IssueTriageView(props: IssueTriageViewProps) {
  const view = useIssueTriageView(props);

  if (!view.hasProject) {
    return (
      <EmptyState
        icon={<FolderIcon size={32} />}
        title="No active project"
        description="Open a project to triage its GitHub issues. Issue Triage lists and validates the active project's open issues."
      />
    );
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-5 py-3">
          <BugIcon size={16} className="text-primary" />
          <h1 className="text-[14px] font-semibold text-foreground">Issue Triage</h1>
          <span className="text-[12.5px] text-muted-foreground">
            · {view.projectName ?? 'GitHub issues'}
          </span>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[340px] shrink-0 flex-col border-r border-border">
            <IssueList
              issues={view.issues}
              totalCount={view.totalCount}
              loading={view.issuesLoading}
              error={view.issuesError}
              filter={view.filter}
              onFilterChange={view.onFilterChange}
              selectedNumber={view.selectedNumber}
              onSelect={view.onSelectIssue}
              onRetry={view.onRefreshIssues}
              badgeByNumber={view.badgeByNumber}
            />
          </aside>

          <main className="min-h-0 flex-1 overflow-y-auto">
            <IssueDetailPanel
              issue={view.selectedIssue}
              detail={view.detail}
              loading={view.detailLoading}
              error={view.detailError}
            />

            {view.selectedIssue !== null && (
              <div className="flex flex-col gap-4 border-t border-border px-5 py-4">
                {view.failed && !view.running && (
                  <div
                    className={
                      view.failedIsCancel
                        ? 'rounded-[10px] border border-border bg-white/[0.02] px-4 py-3 text-[12.5px] text-muted-foreground'
                        : 'rounded-[10px] border border-destructive/40 bg-destructive/[0.08] px-4 py-3 text-[12.5px] text-destructive'
                    }
                  >
                    {view.failedIsCancel
                      ? 'Validation cancelled.'
                      : (view.failureMessage ?? 'Validation failed.')}
                  </div>
                )}

                {view.hasVerdict && !view.running && (
                  <ResultsPanel
                    stream={view.panelStream}
                    stale={view.stale}
                    onPostComment={view.onOpenPostDialog}
                    onConvertToTask={view.onOpenConvertDialog}
                    onGotoBoard={view.onGotoBoard}
                  />
                )}

                <ValidateControls
                  stream={view.panelStream}
                  modelSelection={view.modelSelection}
                  canValidate={view.canValidate}
                  isStarting={view.running}
                  hasVerdict={view.hasVerdict}
                  startError={view.startError}
                  onValidate={view.onValidate}
                  onCancel={view.onCancel}
                />
              </div>
            )}
          </main>
        </div>
      </div>

      <PostCommentDialog
        open={view.postDialog.open}
        body={view.postDialog.body}
        loading={view.postDialog.loading}
        error={view.postDialog.error}
        posting={view.postDialog.posting}
        onClose={view.onClosePostDialog}
        onPost={view.onSubmitPost}
      />

      <ConvertToTaskDialog
        open={view.convertDialog.open}
        issueNumber={view.selectedNumber}
        issueTitle={view.selectedIssue?.title ?? ''}
        suggestedKind={view.suggestedKind}
        complexityLabel={view.complexityLabel}
        effortLabel={view.effortLabel}
        converting={view.convertDialog.converting}
        alreadyLinked={view.alreadyLinked}
        error={view.convertDialog.error}
        onClose={view.onCloseConvertDialog}
        onConvert={view.onSubmitConvert}
        onGotoBoard={view.onGotoBoard}
      />
    </>
  );
}
