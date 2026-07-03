/** The Insight finding grid: maps findings to the shared {@link DetailCard} and
 *  lays them out (with streaming skeletons + empty state) via {@link DetailCardGrid}. */
import { memo } from 'react';

import { DetailCard, DetailCardGrid } from '@/components/ui';
import { formatLocation } from '@/lib/formatters';

import {
  CATEGORY_META,
  EFFORT_META,
  SEVERITY_META,
} from '../insight.constants';
import type { InsightFinding } from '../insight.types';
import { useStableOnOpen } from './FindingGrid.hooks';
import type { FindingGridProps } from './FindingGrid.types';

/** One finding card: severity/effort badges, category glyph, title, grounded
 *  file:line, and a truncated description. Clickable → the detail panel.
 *
 *  `memo`ized so a single finding's status change (dismiss/convert) re-renders
 *  only that one card — every other card keeps a stable `finding` object ref
 *  (the upstream `.map` preserves refs for unchanged findings) and a stable
 *  `onOpen` (see {@link useStableOnOpen}), so the list no longer re-renders in
 *  full on a per-item update. */
const FindingCard = memo(function FindingCard({
  finding,
  onOpen,
}: {
  finding: InsightFinding;
  onOpen: (finding: InsightFinding) => void;
}) {
  const sev = SEVERITY_META[finding.severity];
  const Meta = CATEGORY_META[finding.category];
  const Icon = Meta.icon;
  const dimmed = finding.status !== 'open';

  return (
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
      location={formatLocation(finding.location)}
      description={finding.description}
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
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {EFFORT_META[finding.effort].label}
          </span>
          {finding.status === 'converted' && (
            <span className="rounded-md bg-success/[0.12] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-success">
              task
            </span>
          )}
          {finding.status === 'dismissed' && (
            <span className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
              dismissed
            </span>
          )}
        </>
      }
    />
  );
});

/** The finding grid. Renders real cards, then any streaming skeletons; falls back
 *  to an empty message when there is nothing to show and nothing in flight. */
export function FindingGrid({
  findings,
  skeletonCount,
  emptyMessage,
  onOpen,
}: FindingGridProps) {
  const stableOpen = useStableOnOpen(onOpen);
  return (
    <DetailCardGrid
      isEmpty={findings.length === 0 && skeletonCount === 0}
      emptyMessage={emptyMessage}
      skeletonCount={skeletonCount}
    >
      {findings.map((finding) => (
        <FindingCard key={finding.id} finding={finding} onOpen={stableOpen} />
      ))}
    </DetailCardGrid>
  );
}
