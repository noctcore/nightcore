/** The PR Review results grid: findings grouped into severity sections (headers
 *  over SEVERITY_ORDER), each card carrying a selection {@link Checkbox} whose
 *  checked findings compose the posted GitHub review. Cards use the shared
 *  {@link DetailCard} / {@link DetailCardGrid} chrome (severity section headers span
 *  the grid via `col-span-full`). */
import type { ReactNode } from 'react';

import { Checkbox, DetailCard, DetailCardGrid } from '@/components/ui';

import { LENS_META, SEVERITY_META, SEVERITY_ORDER } from '../prreview.constants';
import type { ReviewFindingView } from '../prreview.types';
import type { ReviewFindingsProps } from './ReviewFindings.types';

/** Format a review finding's grounded location as `file:line` (or `file` when the
 *  finding is not line-localizable). */
function formatReviewLocation(finding: ReviewFindingView): string {
  return finding.line !== null ? `${finding.file}:${finding.line}` : finding.file;
}

/** One finding card: the selection checkbox above the shared card chrome
 *  (severity + lens badges, grounded file:line, and the inert body text). */
function ReviewCard({
  finding,
  selected,
  onToggleSelect,
  onOpen,
}: {
  finding: ReviewFindingView;
  selected: boolean;
  onToggleSelect: (findingId: string) => void;
  onOpen: (finding: ReviewFindingView) => void;
}) {
  const sev = SEVERITY_META[finding.severity];
  const Meta = LENS_META[finding.lens];
  const Icon = Meta.icon;
  const dimmed = finding.status !== 'open';

  return (
    <div className="flex flex-col gap-2">
      {/* Selection lives OUTSIDE the DetailCard button (which is itself
          interactive) so toggling it never opens the detail panel. Dismissed
          findings can't be posted, so their checkbox is disabled. */}
      <Checkbox
        checked={selected}
        onChange={() => onToggleSelect(finding.id)}
        label="Include in review"
        disabled={finding.status === 'dismissed'}
      />
      <DetailCard
        onClick={() => onOpen(finding)}
        dimmed={dimmed}
        hoverTitle={
          dimmed
            ? finding.status === 'converted'
              ? 'Converted to task'
              : 'Dismissed'
            : undefined
        }
        title={finding.title}
        location={formatReviewLocation(finding)}
        description={finding.body}
        badges={
          <>
            <span
              className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${sev.chip} ${sev.tone}`}
            >
              {sev.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              <Icon size={11} />
              {Meta.label}
            </span>
            {finding.status === 'converted' && (
              <span className="ml-auto rounded-md bg-success/[0.12] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-success">
                task
              </span>
            )}
            {finding.status === 'dismissed' && (
              <span className="ml-auto rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
                dismissed
              </span>
            )}
          </>
        }
      />
    </div>
  );
}

/** The results grid: findings bucketed by severity (highest first), each section a
 *  `col-span-full` header followed by its cards. Falls back to the empty message
 *  when there is nothing to show and nothing streaming. */
export function ReviewFindings({
  findings,
  skeletonCount,
  emptyMessage,
  selection,
  onToggleSelect,
  onOpen,
}: ReviewFindingsProps) {
  const children: ReactNode[] = [];
  for (const severity of SEVERITY_ORDER) {
    const items = findings.filter((f) => f.severity === severity);
    if (items.length === 0) continue;
    const meta = SEVERITY_META[severity];
    children.push(
      <div
        key={`section-${severity}`}
        className="col-span-full flex items-center gap-2 pt-3 first:pt-0"
      >
        <span
          className={`font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ${meta.tone}`}
        >
          {meta.label}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {items.length}
        </span>
      </div>,
    );
    for (const finding of items) {
      children.push(
        <ReviewCard
          key={finding.id}
          finding={finding}
          selected={selection.has(finding.id)}
          onToggleSelect={onToggleSelect}
          onOpen={onOpen}
        />,
      );
    }
  }

  return (
    <DetailCardGrid
      isEmpty={findings.length === 0 && skeletonCount === 0}
      emptyMessage={emptyMessage}
      skeletonCount={skeletonCount}
    >
      {/* `children` is a flat list of already-keyed section headers + cards. */}
      {children}
    </DetailCardGrid>
  );
}
