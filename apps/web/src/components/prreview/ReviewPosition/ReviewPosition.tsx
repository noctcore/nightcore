/** The results-header REVIEW-POSITION layer: a posted-verdict reconciliation
 *  banner, a branch-moved staleness chip, the displayed run's synthesis merge
 *  verdict (with collapsible reasoning), and a latest-vs-previous follow-up
 *  summary. Purely presentational — every value is derived in the PrReviewView
 *  model; the component renders nothing when the PR has no position to show. */
import {
  AlertIcon,
  BranchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@/components/ui';

import { mergeVerdictMeta } from '../prreview.constants';
import { hasPositionContent, useReasoningCollapse } from './ReviewPosition.hooks';
import type { ReviewPositionProps } from './ReviewPosition.types';

export function ReviewPosition(props: ReviewPositionProps) {
  const { verdict, verdictReasoning, reconciliation, stale, followup, onReReview } =
    props;
  const reasoning = useReasoningCollapse();

  if (!hasPositionContent(props)) return null;

  const verdictMeta = mergeVerdictMeta(verdict ?? '');

  return (
    <div className="flex flex-col gap-3">
      {/* Reconciliation: a posted approval now contradicted by the live status.
          Mirrors the reference "verdict may be outdated" banner. role=status so
          its appearance is announced when the contradicting status lands. */}
      {reconciliation.length > 0 && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-[10px] border border-warning/50 bg-warning/[0.08] px-4 py-3"
        >
          <AlertIcon size={16} className="mt-0.5 shrink-0 text-warning" />
          <div className="flex flex-1 flex-col gap-1.5">
            <p className="text-xs-plus font-semibold text-warning">
              Review verdict may be out of date
            </p>
            <ul className="flex flex-col gap-1 text-xs-flat text-warning/90">
              {reconciliation.map((reason) => (
                <li key={reason} className="flex items-center gap-2">
                  <span className="h-1 w-1 shrink-0 rounded-full bg-warning/70" />
                  {reason}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onReReview}
              className="mt-1 w-fit text-xs-flat font-medium text-warning transition-[filter] hover:brightness-110"
            >
              Re-review the PR
            </button>
          </div>
        </div>
      )}

      {/* Staleness: the branch advanced past the reviewed head. role=status so the
          chip is announced when the live status resolves it. */}
      {stale && (
        <div role="status" className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/[0.1] px-2 py-0.5 text-2xs-plus font-medium text-warning">
            <BranchIcon size={12} className="shrink-0" />
            Branch has moved since this review
          </span>
          <button
            type="button"
            onClick={onReReview}
            className="text-xs-flat font-medium text-warning transition-[filter] hover:brightness-110"
          >
            Re-review
          </button>
        </div>
      )}

      {/* Header row: the merge-verdict badge (+ collapsible reasoning) and the
          follow-up comparison summary. */}
      {(verdictMeta !== null || followup !== null) && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-3">
            {verdictMeta !== null && (
              <span className="inline-flex items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-3xs font-semibold uppercase tracking-[0.06em] ${verdictMeta.badgeClass}`}
                >
                  {verdictMeta.label}
                </span>
                {verdictReasoning !== null && verdictReasoning.length > 0 && (
                  <button
                    type="button"
                    onClick={reasoning.toggle}
                    aria-expanded={reasoning.expanded}
                    className="inline-flex items-center gap-1 text-2xs-plus font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {reasoning.expanded ? (
                      <ChevronDownIcon size={12} />
                    ) : (
                      <ChevronRightIcon size={12} />
                    )}
                    {reasoning.expanded ? 'Hide reasoning' : 'Why this verdict?'}
                  </button>
                )}
              </span>
            )}

            {followup !== null && (
              <span className="ml-auto inline-flex items-center gap-2 font-mono text-2xs text-muted-foreground">
                <span className="text-success">{followup.resolved} resolved</span>
                <span aria-hidden>·</span>
                <span className="text-warning">{followup.stillOpen} still open</span>
                <span aria-hidden>·</span>
                <span className="text-primary">{followup.added} new</span>
              </span>
            )}
          </div>

          {/* The synthesis justification — Nightcore's own AI text, rendered as
              plain (escaped) text, never markdown/HTML. */}
          {reasoning.expanded &&
            verdictReasoning !== null &&
            verdictReasoning.length > 0 && (
              <p className="rounded-[8px] border border-border bg-white/[0.02] px-3 py-2 text-xs-plus leading-relaxed text-muted-foreground">
                {verdictReasoning}
              </p>
            )}
        </div>
      )}
    </div>
  );
}
