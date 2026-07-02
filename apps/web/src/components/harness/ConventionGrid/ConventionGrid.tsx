/** The Harness convention grid: maps convention findings to the shared
 *  {@link DetailCard} and lays them out (with streaming skeletons + empty state)
 *  via {@link DetailCardGrid}. */
import { DetailCard, DetailCardGrid } from '@/components/ui';
import { formatLocation } from '@/lib/formatters';

import { CATEGORY_META, KIND_META, SEVERITY_META } from '../harness.constants';
import type { ConventionFindingVM } from '../harness.types';
import type { ConventionGridProps } from './ConventionGrid.types';

/** Headline the first grounded evidence anchor, with a `+N` overflow when the
 *  convention spans more files (a convention is a repo-wide pattern). */
function evidenceLabel(finding: ConventionFindingVM): string | null {
  const [first] = finding.evidence;
  if (first === undefined) return null;
  const base = formatLocation(first);
  if (base === null) return null;
  const more = finding.evidence.length - 1;
  return more > 0 ? `${base} +${more}` : base;
}

/** One convention card: severity + kind badges, lens glyph, title, grounded
 *  evidence, and a truncated description. Clickable → the detail panel. */
function ConventionCard({
  finding,
  onOpen,
}: {
  finding: ConventionFindingVM;
  onOpen: (finding: ConventionFindingVM) => void;
}) {
  const sev = SEVERITY_META[finding.severity];
  const kind = KIND_META[finding.kind];
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
      location={evidenceLabel(finding)}
      description={finding.description}
      badges={
        <>
          <span
            className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${sev.chip} ${sev.tone}`}
          >
            {sev.label}
          </span>
          <span
            className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${kind.chip} ${kind.tone}`}
          >
            {kind.label}
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
  );
}

/** The convention grid. Renders real cards, then any streaming skeletons; falls
 *  back to an empty message when there is nothing to show and nothing in flight. */
export function ConventionGrid({
  findings,
  skeletonCount,
  emptyMessage,
  onOpen,
}: ConventionGridProps) {
  return (
    <DetailCardGrid
      isEmpty={findings.length === 0 && skeletonCount === 0}
      emptyMessage={emptyMessage}
      skeletonCount={skeletonCount}
    >
      {findings.map((finding) => (
        <ConventionCard key={finding.id} finding={finding} onOpen={onOpen} />
      ))}
    </DetailCardGrid>
  );
}
