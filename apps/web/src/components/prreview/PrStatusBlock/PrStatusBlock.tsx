/** Live GitHub status for the selected PR (the workspace's STATUS BLOCK):
 *  the merge-readiness badge (ready / needs review / needs fixing / conflicts),
 *  state/review badges, merge-state line, checks summary, the base branch —
 *  fetched on selection + manual refresh only (NO polling) — plus the
 *  REMEDIATION actions ("Fix CI" when checks fail, "Resolve conflicts" when the
 *  PR conflicts with base), which arm human gates in the owner. Renders the
 *  same gh-vocabulary mappers as the board's PrStatusCard, from
 *  `@/lib/pr-status`. */
import { useId } from 'react';

import {
  BranchIcon,
  MergeIcon,
  PrChecksLine,
  RefactorIcon,
  RefreshedAtLine,
  RetryIcon,
  Spinner,
} from '@/components/ui';
import {
  checksSummary,
  mergeReadiness,
  mergeStateLine,
  prStateBadge,
  prStatusFallbackMessage,
  reviewDecisionBadge,
} from '@/lib/pr-status';

import { usePrStatusByNumber } from './PrStatusBlock.hooks';
import type { PrStatusBlockProps } from './PrStatusBlock.types';

/** Shared chip classes for the state/review badges (tone comes from the mapper). */
const BADGE_BASE =
  'inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-3xs font-semibold uppercase tracking-[0.06em]';

/** The inert-while-busy reason for the remediation buttons (sr-only + title). */
const FIX_BUSY_TITLE = 'A fix for this PR is already in progress.';

/** Shared classes for the small remediation buttons on the status rows. */
const ACTION_BASE =
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-2xs-plus font-medium transition-colors';

export function PrStatusBlock({
  prNumber,
  view: liftedView,
  override,
  actions,
}: PrStatusBlockProps) {
  // The sr-only disabled-reason span the inert remediation buttons point at
  // via aria-describedby (the guarded-toolbar precedent from ReviewSection).
  const busyReasonId = useId();
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
  const readiness = status !== null ? mergeReadiness(status) : null;
  const showFixCi = actions !== undefined && status !== null && status.checksFailed > 0;
  const showResolveConflicts =
    actions !== undefined && status !== null && status.mergeable === 'CONFLICTING';
  const fixBusy = actions?.fixBusy === true;
  const actionClass = fixBusy
    ? `${ACTION_BASE} cursor-not-allowed border-border text-muted-foreground opacity-40`
    : `${ACTION_BASE} border-border text-muted-foreground hover:border-white/20 hover:text-foreground`;

  return (
    <section
      aria-label={`PR #${prNumber} status`}
      className="flex flex-col gap-2 rounded-[12px] border border-border bg-white/[0.02] px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
          Status
        </span>
        <button
          type="button"
          onClick={view.refresh}
          disabled={view.fetching}
          className="ml-auto inline-flex items-center gap-1 text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {view.fetching ? <Spinner size={11} /> : <RetryIcon size={11} />}
          Refresh
        </button>
      </div>

      {status !== null && state !== null ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Merge readiness first — the badge that answers "can this merge,
                and if not, why not" at a glance. */}
            {readiness !== null && (
              <span className={`${BADGE_BASE} ${readiness.className}`}>
                {readiness.label}
              </span>
            )}
            <span className={`${BADGE_BASE} ${state.className}`}>{state.label}</span>
            {review !== null && (
              <span className={`${BADGE_BASE} ${review.className}`}>
                {review.label}
              </span>
            )}
            <span className="inline-flex items-center gap-1 font-mono text-2xs text-muted-foreground">
              <BranchIcon size={11} />
              base: {status.baseRefName || 'unknown'}
            </span>
          </div>
          {/* Inert-reason target for the remediation buttons below (they stay
              focusable via aria-disabled, the guarded-toolbar precedent). */}
          <span id={busyReasonId} className="sr-only">
            {FIX_BUSY_TITLE}
          </span>
          {mergeLine !== null && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs-plus text-muted-foreground">{mergeLine}</p>
              {showResolveConflicts && (
                <button
                  type="button"
                  aria-disabled={fixBusy}
                  aria-describedby={fixBusy ? busyReasonId : undefined}
                  title={fixBusy ? FIX_BUSY_TITLE : undefined}
                  onClick={() => {
                    if (!fixBusy) actions.onResolveConflicts();
                  }}
                  className={actionClass}
                >
                  <MergeIcon size={12} />
                  Resolve conflicts
                </button>
              )}
            </div>
          )}
          {checks !== null && (
            <div className="flex flex-wrap items-center gap-2">
              <PrChecksLine checks={checks} label="Checks:" className="text-2xs-plus" />
              {showFixCi && (
                <button
                  type="button"
                  aria-disabled={fixBusy}
                  aria-describedby={fixBusy ? busyReasonId : undefined}
                  title={fixBusy ? FIX_BUSY_TITLE : undefined}
                  onClick={() => {
                    if (!fixBusy) actions.onFixCi();
                  }}
                  className={actionClass}
                >
                  <RefactorIcon size={12} />
                  Fix CI
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs-plus text-muted-foreground">
          {prStatusFallbackMessage(view)}
        </p>
      )}

      {view.error !== null && (
        <p role="alert" className="text-xs-flat text-destructive">
          {view.error}
        </p>
      )}
      {view.refreshedAt !== null && (
        <RefreshedAtLine refreshedAt={view.refreshedAt} />
      )}
    </section>
  );
}
