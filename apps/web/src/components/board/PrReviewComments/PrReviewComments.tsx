/** Read-only "Review comments" surface for TaskDetail (PR phase 3): the
 *  UNRESOLVED inline review threads + top-level review summaries fetched via a
 *  bounded `gh api graphql`, plus the single human-gated "Address comments"
 *  action (dispatches a fix run over the task's worktree), plus an on-demand,
 *  read-only "Triage" action that AI-classifies each thread (actionable /
 *  false-positive / already-addressed / question) into a per-thread chip. Every
 *  comment body is UNTRUSTED external text — rendered as plain, pre-wrapped text,
 *  NEVER as HTML (no `dangerouslySetInnerHTML`, no markdown). Thin shell — all
 *  state/effects live in `PrReviewComments.hooks.ts`. */
import { BuildIcon, Button, ConfirmDialog, RetryIcon, SparkIcon, Spinner } from '@/components/ui';

import {
  actionableCount,
  addressConfirmCopy,
  BADGE_BASE,
  BADGE_NEUTRAL,
  canAddressComments,
  formatRefreshedAt,
  reviewStateBadge,
  threadAnchor,
  triageClassChip,
  triageForIndex,
  useAddressConfirm,
  useTriage,
} from './PrReviewComments.hooks';
import type { PrReviewCommentsProps } from './PrReviewComments.types';

export function PrReviewComments({
  task,
  view,
  onAddressComments,
  isActionPending,
}: PrReviewCommentsProps) {
  const confirm = useAddressConfirm(task.id, onAddressComments);
  const { comments } = view;
  // Pass the comments so the triage verdicts (which index-align to the threads)
  // invalidate when the displayed thread set changes (e.g. after a Refresh).
  const triage = useTriage(task.id, comments);
  const count = actionableCount(comments);
  const threadCount = comments?.threads.length ?? 0;
  const pending = isActionPending?.('addressPrComments', task.id) ?? false;
  const canAddress = canAddressComments(task, comments);

  return (
    <section className="rounded-md border border-border bg-white/[0.02] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {count > 0
            ? `${count} unresolved comment${count === 1 ? '' : 's'}`
            : view.fetching
              ? 'Fetching review comments…'
              : view.unavailable
                ? 'Review comments are unavailable in the browser preview.'
                : view.error !== null
                  ? 'Review comments failed to load.'
                  : 'No unresolved review comments.'}
        </span>
        <span className="flex-1" />
        {threadCount > 0 && (
          <Button
            variant="ghost"
            onClick={triage.run}
            disabled={triage.triaging}
            aria-busy={triage.triaging}
            // No confirm gate (read-only, small cost) — the cost rides in the copy.
            title={`Classify ${threadCount} thread${threadCount === 1 ? '' : 's'} with AI`}
          >
            {triage.triaging ? <Spinner size={14} /> : <SparkIcon size={14} />}
            Triage
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={view.refresh}
          disabled={view.fetching}
          aria-busy={view.fetching}
        >
          {view.fetching ? <Spinner size={14} /> : <RetryIcon size={14} />}
          Refresh
        </Button>
      </div>

      {comments !== null && count > 0 && (
        <div className="mt-2.5 space-y-2.5">
          {comments.threads.map((thread, i) => {
            const verdict = triageForIndex(triage.triage, i);
            const chip = verdict !== undefined ? triageClassChip(verdict.class) : null;
            return (
            <div
              key={`thread-${i}`}
              className="rounded-md border border-border bg-black/15 px-2.5 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-[11px] text-foreground/90">
                  {threadAnchor(thread.path, thread.line)}
                </span>
                {thread.isOutdated && (
                  <span className={`${BADGE_BASE} ${BADGE_NEUTRAL}`}>outdated</span>
                )}
                {chip !== null && verdict !== undefined && (
                  // The note rides as the tooltip; the class drives the tone.
                  <span
                    className={`${BADGE_BASE} ${chip.className}`}
                    title={verdict.note.length > 0 ? verdict.note : undefined}
                  >
                    {chip.label}
                  </span>
                )}
              </div>
              <div className="mt-1.5 space-y-1.5">
                {thread.comments.map((comment, j) => (
                  <div key={j}>
                    <p className="font-mono text-[10px] text-muted-foreground">{comment.author}</p>
                    {/* UNTRUSTED body — plain pre-wrapped text, never HTML/markdown. */}
                    <p className="whitespace-pre-wrap break-words text-xs text-foreground/90">
                      {comment.body}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            );
          })}
          {comments.reviews.map((review, i) => {
            const badge = reviewStateBadge(review.state);
            return (
              <div
                key={`review-${i}`}
                className="rounded-md border border-border bg-black/15 px-2.5 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-foreground/90">{review.author}</span>
                  <span className={`${BADGE_BASE} ${badge.className}`}>{badge.label}</span>
                </div>
                {/* UNTRUSTED body — plain pre-wrapped text, never HTML/markdown. */}
                <p className="mt-1.5 whitespace-pre-wrap break-words text-xs text-foreground/90">
                  {review.body}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {view.error !== null && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {view.error}
        </p>
      )}

      {triage.error !== null && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          Triage failed: {triage.error}
        </p>
      )}

      {onAddressComments !== undefined && (
        <div className="mt-2.5 flex items-center gap-2">
          <Button
            onClick={confirm.arm}
            disabled={!canAddress || pending}
            aria-busy={pending}
            title={
              task.merged
                ? 'The task is already merged — nothing to address'
                : count === 0
                  ? 'No unresolved review comments to address'
                  : !canAddress
                    ? 'Wait for the current run to finish'
                    : undefined
            }
          >
            {pending ? <Spinner size={14} /> : <BuildIcon size={14} />}
            Address comments
          </Button>
        </div>
      )}

      {view.refreshedAt !== null && (
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">
          Refreshed {formatRefreshedAt(view.refreshedAt)}
        </p>
      )}

      {confirm.arming && (
        <ConfirmDialog
          {...addressConfirmCopy(count)}
          onConfirm={confirm.confirm}
          onCancel={confirm.cancel}
        />
      )}
    </section>
  );
}
