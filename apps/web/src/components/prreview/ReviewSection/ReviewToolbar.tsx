/** The completed-run ACTION TOOLBAR of the review section: convert-all, address
 *  findings, and the three human-gated post verdicts. Split out of `ReviewSection`
 *  (its own file-size ratchet) — the same sibling-component shape `ReviewFindings`
 *  uses for its row/group. Purely presentational: every action opens a gate or a
 *  registry call in the PrReviewView model; nothing here fires a side effect. */
import { useId } from 'react';

import { Button, CheckIcon, MoveIcon, RefactorIcon } from '@/components/ui';

import {
  FIX_RUNNING_TITLE,
  OWN_PR_TITLE,
  RECOMMENDED_VERDICT_TITLE,
  VERDICT_META,
} from '../prreview.constants';
import type { ReviewVerdict } from '../prreview.types';
import type { ReviewSectionToolbarSlice } from './ReviewSection.types';

/** The three post-review verdict buttons, in display order. */
const VERDICTS: ReviewVerdict[] = ['approve', 'request-changes', 'comment'];

export function ReviewToolbar({ toolbar }: { toolbar: ReviewSectionToolbarSlice }) {
  // Ids for the sr-only reason spans the guarded/recommended buttons point at via
  // aria-describedby (`useId` is render-safe — allowlisted by the
  // no-state-in-component-body rule).
  const reasonsId = useId();
  const ownPrReasonId = `${reasonsId}-own-pr`;
  const fixRunningReasonId = `${reasonsId}-fix-running`;
  const recommendedReasonId = `${reasonsId}-recommended`;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
      <Button
        aria-busy={toolbar.bulkConverting}
        aria-disabled={toolbar.openCount === 0 || toolbar.bulkConverting}
        onClick={() => {
          if (toolbar.openCount > 0 && !toolbar.bulkConverting) {
            toolbar.onConvertAll();
          }
        }}
        variant="secondary"
        className={
          toolbar.openCount === 0 || toolbar.bulkConverting
            ? 'cursor-not-allowed opacity-40'
            : undefined
        }
      >
        <MoveIcon size={15} />
        {toolbar.bulkConverting
          ? `Converting… ${toolbar.bulkProgress.done}/${toolbar.bulkProgress.total}`
          : `Convert all to tasks (${toolbar.openCount})`}
      </Button>
      {/* Sr-only reasons: the guarded/recommended buttons stay focusable and point
          here via aria-describedby so keyboard/SR users hear WHY (the `title`
          twins cover mouse hover). */}
      <span id={ownPrReasonId} className="sr-only">
        {OWN_PR_TITLE}
      </span>
      <span id={fixRunningReasonId} className="sr-only">
        {FIX_RUNNING_TITLE}
      </span>
      <span id={recommendedReasonId} className="sr-only">
        {RECOMMENDED_VERDICT_TITLE}
      </span>

      {/* Address findings: opens the ConfirmDialog (the human gate for a paid
          agent session that commits to the PR branch — never auto-fires). Inert
          but focusable while this PR already has a fix in flight. */}
      <Button
        variant="secondary"
        aria-disabled={!toolbar.canAddress}
        aria-describedby={toolbar.fixRunning ? fixRunningReasonId : undefined}
        title={toolbar.fixRunning ? FIX_RUNNING_TITLE : undefined}
        onClick={() => {
          if (toolbar.canAddress) toolbar.requestAddress();
        }}
        className={!toolbar.canAddress ? 'cursor-not-allowed opacity-40' : undefined}
      >
        <RefactorIcon size={15} />
        Address findings ({toolbar.addressCount})
      </Button>
      {toolbar.bulkError !== null && (
        <span className="text-xs-flat text-destructive">{toolbar.bulkError}</span>
      )}
      {toolbar.addressError !== null && (
        <span className="text-xs-flat text-destructive">{toolbar.addressError}</span>
      )}

      {/* Post-review verdicts: each opens the ConfirmDialog — none auto-fires.
          Approve/request-changes guard inert on the viewer's OWN PR but stay
          focusable for the aria reason. */}
      <div className="ml-auto flex items-center gap-2">
        {/* Post-success micro-feedback: an auto-clearing confirmation the view
            model shows for a few seconds. role=status announces it; the rise is
            neutralized under prefers-reduced-motion by the global CSS. */}
        {toolbar.postedFeedback !== null && (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/[0.1] px-2.5 py-1 text-2xs-plus font-medium text-success"
            style={{
              animation: 'nc-rise var(--nc-motion-fast) var(--nc-ease-out-quint)',
            }}
          >
            <CheckIcon size={13} />
            Posted {toolbar.postedFeedback}{' '}
            {toolbar.postedFeedback === 1 ? 'finding' : 'findings'}
          </span>
        )}
        <span className="font-mono text-2xs text-muted-foreground">
          {toolbar.selectedCount} selected
        </span>
        {VERDICTS.map((verdict) => {
          const meta = VERDICT_META[verdict];
          const Icon = meta.icon;
          const guarded = toolbar.ownPr && verdict !== 'comment';
          const inert = !toolbar.canPost || guarded;
          // TRUSTED POSTING (#197): the verdict derived from the run's CLAMPED
          // merge verdict is HIGHLIGHTED and announced as recommended, so posting
          // is one informed click rather than a blank decision — the friction
          // behind "zero reviews posted". A recommendation only: every verdict
          // stays clickable, and every one of them opens the ConfirmDialog.
          const recommended = verdict === toolbar.recommendedVerdict;
          return (
            <Button
              key={verdict}
              variant={
                meta.destructive
                  ? 'danger'
                  : recommended && !inert
                    ? 'primary'
                    : 'secondary'
              }
              aria-disabled={inert}
              // The recommendation rides as a DESCRIPTION, never in the accessible
              // NAME: the button is still "Comment", now with "recommended…"
              // announced after it (the own-PR guard's pattern), so name-based
              // queries and screen-reader output stay stable.
              aria-describedby={
                guarded
                  ? ownPrReasonId
                  : recommended && !inert
                    ? recommendedReasonId
                    : undefined
              }
              title={
                guarded
                  ? OWN_PR_TITLE
                  : recommended
                    ? RECOMMENDED_VERDICT_TITLE
                    : undefined
              }
              onClick={() => {
                if (!inert) toolbar.requestPost(verdict);
              }}
              className={inert ? 'cursor-not-allowed opacity-40' : undefined}
            >
              <Icon size={15} />
              {meta.label}
              {recommended && !inert && (
                <span
                  aria-hidden
                  className="rounded-full bg-white/[0.16] px-1.5 py-px font-mono text-3xs font-medium uppercase tracking-[0.08em]"
                >
                  rec
                </span>
              )}
            </Button>
          );
        })}
      </div>

      <span role="status" aria-live="polite" className="sr-only">
        {toolbar.bulkStatusMessage}
      </span>
    </div>
  );
}
