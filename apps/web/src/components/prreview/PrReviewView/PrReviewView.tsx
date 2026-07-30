/** Top-level PR Review surface: a PERMANENT two-panel workspace — the project's
 *  open PRs on the left (with live per-PR run badges), the selected PR's
 *  workspace (header / status / description / registry-driven review section)
 *  on the right — plus the finding detail panel and the human-gated post-review
 *  ConfirmDialog from the `usePrReviewView` model. Selecting a PR never cancels
 *  anything: every run keeps streaming in the run registry. */
import {
  Checkbox,
  ConfirmDialog,
  EmptyState,
  FolderIcon,
  GithubIcon,
} from '@/components/ui';

import { FindingDetailPanel } from '../FindingDetailPanel';
import { PostReviewDialog } from '../PostReviewDialog';
import { PrPicker } from '../PrPicker';
import { PrWorkspace } from '../PrWorkspace';
import { usePrReviewView } from './PrReviewView.hooks';
import type { PrReviewViewProps } from './PrReviewView.types';

export function PrReviewView(props: PrReviewViewProps) {
  const view = usePrReviewView(props);
  const { panel } = view;

  if (!view.hasProject) {
    return (
      <EmptyState
        icon={<FolderIcon size={32} />}
        title="No active project"
        description="Open a project to review its pull requests. PR Review reviews a PR of the active project's repo."
      />
    );
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {/* Header bar: title + project. Refreshing PRs lives on the list rail's
            own Refresh control (the header button was a duplicate). */}
        <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="flex items-center gap-2 truncate text-sm font-semibold text-foreground">
              <GithubIcon size={16} />
              PR Review
            </h2>
            <span className="truncate text-xs-flat text-muted-foreground">
              {view.projectName ?? 'Pull-request review'}
            </span>
          </div>
        </header>

        {/* The permanent two-panel body, split by a draggable persisted divider.
            While dragging, the shell shows the resize cursor + suppresses text
            selection so the drag reads clean. */}
        <div
          className={`flex min-h-0 flex-1 overflow-hidden ${
            panel.dragging ? 'cursor-col-resize select-none' : ''
          }`}
        >
          <aside
            style={{ width: panel.width }}
            className="flex min-h-0 shrink-0 flex-col overflow-hidden"
          >
            <PrPicker
              prs={view.list.prs}
              loading={view.list.prsLoading}
              error={view.list.prsError}
              value={view.list.selectedPr}
              onChange={view.list.selectPr}
              onRefresh={view.list.refreshPrs}
              statuses={view.list.prRowStatuses}
              findingCounts={view.list.prFindingCounts}
              hasMore={view.list.prsHasMore}
              onLoadMore={view.list.loadMorePrs}
              loadingMore={view.list.prsLoadingMore}
            />
          </aside>
          {/* Draggable / keyboard-accessible divider (double-click resets). A
              fixed-width hit area (negative margins keep the layout width stable)
              wraps a 1px line — only the line tints on hover / drag / focus, so
              the handle never changes width and never shoves the panels. */}
          <div
            {...panel.separatorProps}
            className="group/resizer -mx-[2px] flex w-1.5 shrink-0 cursor-col-resize items-stretch justify-center self-stretch focus:outline-none"
          >
            <span
              aria-hidden
              className={`w-px self-stretch transition-colors ${
                panel.dragging
                  ? 'bg-primary/50'
                  : 'bg-border group-hover/resizer:bg-primary/40 group-focus-visible/resizer:bg-primary/60'
              }`}
            />
          </div>
          <main className="min-h-0 flex-1 overflow-y-auto">
            {view.list.selectedPr === null || view.workspace.review === null ? (
              <EmptyState
                icon={<GithubIcon size={32} />}
                title="Select a pull request"
                description="Pick a PR on the left to review it."
              />
            ) : (
              <PrWorkspace
                prNumber={view.list.selectedPr}
                pr={view.workspace.selectedSummary}
                onOpenExternal={view.workspace.onOpenExternal}
                review={view.workspace.review}
                lifecycle={view.workspace.lifecycle}
                statusView={view.workspace.statusView}
                statusActions={view.fix.statusActions}
              />
            )}
          </main>
        </div>
      </div>

      <FindingDetailPanel
        open={view.finding.selected !== null}
        finding={view.finding.selected}
        pending={view.finding.pending}
        onClose={view.finding.closeFinding}
        onConvert={view.finding.onConvert}
        onDismiss={view.finding.onDismiss}
        onRestore={view.finding.onRestore}
        onGotoBoard={view.finding.onGotoBoard}
      />

      {/* Post-review human gate: opens PRE-FILLED (clamped verdict + inline/body
          split), stays fully editable, and posts to GitHub only on an explicit
          confirm. There is no auto-post path. */}
      <PostReviewDialog post={view.post} />

      {/* Address-findings human gate: starting a PAID agent session that will
          COMMIT to the PR branch never auto-fires. Pushing stays a separate,
          separately-gated manual step. */}
      <ConfirmDialog
        open={view.address.addressArmed}
        title={`Address findings on PR #${view.address.addressPrNumber}?`}
        confirmLabel="Start fix agent"
        busy={view.address.addressing}
        onConfirm={view.address.confirmAddress}
        onCancel={view.address.cancelAddress}
        message={
          <div className="flex flex-col gap-2">
              <span>
                Run a fix agent on{' '}
                <span className="font-mono text-foreground">
                  PR #{view.address.addressPrNumber}
                </span>
                &apos;s branch addressing{' '}
                <span className="font-semibold text-foreground">
                  {view.address.addressCount}
                </span>{' '}
                selected {view.address.addressCount === 1 ? 'finding' : 'findings'}? It
                will commit to the branch; pushing stays a separate manual step.
              </span>
              {view.address.addressError !== null && (
                <span
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/[0.1] px-3 py-2 text-xs-plus text-destructive"
                >
                  {view.address.addressError}
                </span>
              )}
            </div>
        }
      />

      {/* Push-fix human gate: THE external side effect of the fix arc. The
          dialog names the branch + PR, warns it publishes the commits, and
          carries the summary-comment opt-in (the comment embeds the fix
          session's summary shown on the card). */}
      <ConfirmDialog
        open={view.fix.pushArmedFix !== null}
        title={view.fix.pushArmedFix !== null ? `Push fix to PR #${view.fix.pushArmedFix.prNumber}?` : ''}
        confirmLabel={
          view.fix.pushArmedFix !== null ? `Push to PR #${view.fix.pushArmedFix.prNumber}` : ''
        }
        busy={view.fix.pushing}
        onConfirm={view.fix.confirmPush}
        onCancel={view.fix.cancelPush}
        message={
          view.fix.pushArmedFix !== null ? (
            <div className="flex flex-col gap-3">
              <span>
                Push the fix commit on{' '}
                <span className="font-mono text-foreground">
                  {view.fix.pushArmedFix.branch}
                </span>{' '}
                to{' '}
                <span className="font-mono text-foreground">
                  PR #{view.fix.pushArmedFix.prNumber}
                </span>
                ? This publishes the commits to the pull request on GitHub.
              </span>
              <Checkbox
                checked={view.fix.pushPostComment}
                onChange={view.fix.setPushPostComment}
                disabled={view.fix.pushing}
                label="Also post a summary comment describing how the fix addressed its targets"
              />
              {view.fix.pushError !== null && (
                <span
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/[0.1] px-3 py-2 text-xs-plus text-destructive"
                >
                  {view.fix.pushError}
                </span>
              )}
            </div>
          ) : null
        }
      />

      {/* Status-block remediation gates: starting a PAID agent session (CI fix
          / conflict resolution) never auto-fires — same discipline as the
          address gate. The dialog explains what the agent will do; the fix
          strip and push gate then take over. */}
      <ConfirmDialog
        open={view.fix.fixActionArmed !== null && view.list.selectedPr !== null}
        title={
          view.fix.fixActionArmed === 'ci'
            ? `Fix failing CI on PR #${view.list.selectedPr}?`
            : `Resolve conflicts on PR #${view.list.selectedPr}?`
        }
        confirmLabel={
          view.fix.fixActionArmed === 'ci' ? 'Start CI fix agent' : 'Start resolve agent'
        }
        busy={view.fix.fixActionBusy}
        onConfirm={view.fix.confirmFixAction}
        onCancel={view.fix.cancelFixAction}
        message={
          <div className="flex flex-col gap-2">
              <span>
                {view.fix.fixActionArmed === 'ci' ? (
                  <>
                    Run a fix agent on{' '}
                    <span className="font-mono text-foreground">
                      PR #{view.list.selectedPr}
                    </span>
                    &apos;s branch to reproduce and fix its failing CI checks? It
                    will commit to the branch; pushing stays a separate manual
                    step.
                  </>
                ) : (
                  <>
                    Merge the base branch into{' '}
                    <span className="font-mono text-foreground">
                      PR #{view.list.selectedPr}
                    </span>
                    &apos;s checkout and resolve the conflicts? A clean merge
                    skips the agent; either way pushing stays a separate manual
                    step.
                  </>
                )}
              </span>
              {view.fix.fixActionError !== null && (
                <span
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/[0.1] px-3 py-2 text-xs-plus text-destructive"
                >
                  {view.fix.fixActionError}
                </span>
              )}
            </div>
        }
      />
    </>
  );
}
