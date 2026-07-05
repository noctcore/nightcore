/** Live GitHub status for the selected PR (the workspace's STATUS BLOCK):
 *  state/review badges, merge-state line, checks summary, and the base branch —
 *  fetched on selection + manual refresh only (NO polling). Renders the same
 *  gh-vocabulary mappers as the board's PrStatusCard, from `@/lib/pr-status`. */
import { BranchIcon, RetryIcon, Spinner } from '@/components/ui';
import {
  checksSummary,
  mergeStateLine,
  prStateBadge,
  reviewDecisionBadge,
} from '@/lib/pr-status';

import { formatRefreshedAt, usePrStatusByNumber } from './PrStatusBlock.hooks';
import type { PrStatusBlockProps } from './PrStatusBlock.types';

/** Shared chip classes for the state/review badges (tone comes from the mapper). */
const BADGE_BASE =
  'inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em]';

export function PrStatusBlock({ prNumber, view: liftedView, override }: PrStatusBlockProps) {
  // Self-fetch ONLY when no lifted view is provided (stories/tests): the app
  // path lifts `usePrStatusByNumber` into the PrReviewView model so the status
  // line + review-position banners share the fetched state — the hook here stays
  // mounted (rules of hooks) but inert. Mirrors the board's PrStatusCard.
  const selfView = usePrStatusByNumber(prNumber, override, liftedView === undefined);
  const view = liftedView ?? selfView;
  const { status } = view;

  const state = status !== null ? prStateBadge(status) : null;
  const review = status !== null ? reviewDecisionBadge(status) : null;
  const mergeLine = status !== null ? mergeStateLine(status) : null;
  const checks = status !== null ? checksSummary(status) : null;

  return (
    <section
      aria-label={`PR #${prNumber} status`}
      className="flex flex-col gap-2 rounded-[12px] border border-border bg-white/[0.02] px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          Status
        </span>
        <button
          type="button"
          onClick={view.refresh}
          disabled={view.fetching}
          className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {view.fetching ? <Spinner size={11} /> : <RetryIcon size={11} />}
          Refresh
        </button>
      </div>

      {status !== null && state !== null ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`${BADGE_BASE} ${state.className}`}>{state.label}</span>
            {review !== null && (
              <span className={`${BADGE_BASE} ${review.className}`}>
                {review.label}
              </span>
            )}
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
              <BranchIcon size={11} />
              base: {status.baseRefName || 'unknown'}
            </span>
          </div>
          {mergeLine !== null && (
            <p className="text-[12.5px] text-muted-foreground">{mergeLine}</p>
          )}
          {checks !== null && (
            <p className="font-mono text-[11.5px] text-muted-foreground">
              Checks:{' '}
              <span className="text-success">{checks.passed} passed</span>
              {' · '}
              <span className={checks.failed > 0 ? 'text-destructive' : undefined}>
                {checks.failed} failed
              </span>
              {' · '}
              <span className={checks.pending > 0 ? 'text-warning' : undefined}>
                {checks.pending} pending
              </span>
            </p>
          )}
        </div>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          {view.fetching
            ? 'Fetching PR status…'
            : view.unavailable
              ? 'PR status is unavailable in the browser preview.'
              : view.error !== null
                ? 'PR status failed to load.'
                : 'PR status not loaded yet.'}
        </p>
      )}

      {view.error !== null && (
        <p role="alert" className="text-[12px] text-destructive">
          {view.error}
        </p>
      )}
      {view.refreshedAt !== null && (
        <p className="text-[10.5px] text-muted-foreground/70">
          Refreshed {formatRefreshedAt(view.refreshedAt)}
        </p>
      )}
    </section>
  );
}
