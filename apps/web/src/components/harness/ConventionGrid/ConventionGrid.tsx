/** The ConventionGrid of convention finding cards with streaming skeletons. */
import { Card, Skeleton } from '@/components/ui';
import { CATEGORY_META, KIND_META, SEVERITY_META } from '../harness.constants';
import type { ConventionFindingVM } from '../harness.types';
import type { ConventionGridProps } from './ConventionGrid.types';

/** Headline the first grounded evidence anchor, with a `+N` overflow when the
 *  convention spans more files (a convention is a repo-wide pattern). */
function evidenceLabel(finding: ConventionFindingVM): string | null {
  const [first] = finding.evidence;
  if (first === undefined) return null;
  const range =
    first.startLine !== null
      ? `:${
          first.endLine !== null && first.endLine !== first.startLine
            ? `${first.startLine}-${first.endLine}`
            : first.startLine
        }`
      : '';
  const more = finding.evidence.length - 1;
  return `${first.file}${range}${more > 0 ? ` +${more}` : ''}`;
}

/** One convention card: severity + kind badges, lens glyph, title, grounded
 *  evidence, and a truncated description. Clickable → the detail panel. Inlined
 *  here as a module-local since the grid is its only consumer. */
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
  const loc = evidenceLabel(finding);
  const dimmed = finding.status !== 'open';

  return (
    <Card
      onClick={() => onOpen(finding)}
      title={dimmed ? 'Dismissed' : undefined}
      className="flex flex-col gap-2 p-3.5 text-left"
    >
      <div className="flex items-center gap-2">
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
        {finding.status === 'dismissed' && (
          <span className="ml-auto rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
            dismissed
          </span>
        )}
      </div>

      <h3 className={`text-[13.5px] font-semibold leading-snug ${dimmed ? 'text-muted-foreground' : 'text-foreground'}`}>
        {finding.title}
      </h3>

      {loc !== null && (
        <code className={`truncate font-mono text-[11px] ${dimmed ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
          {loc}
        </code>
      )}

      <p className={`line-clamp-2 text-[12px] leading-relaxed ${dimmed ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
        {finding.description}
      </p>
    </Card>
  );
}

/** A skeleton convention card that preserves the card layout while a lens pass is
 *  still running (streaming UX). */
function SkeletonCard() {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-white/[0.02] p-3.5">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-14" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-24" />
      </div>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
    </div>
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
  const empty = findings.length === 0 && skeletonCount === 0;

  if (empty) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      </div>
    );
  }

  return (
    <div
      aria-busy={skeletonCount > 0}
      className="grid flex-1 grid-cols-1 content-start gap-3 overflow-y-auto px-6 py-5 sm:grid-cols-2 xl:grid-cols-3"
    >
      {findings.map((finding) => (
        <ConventionCard key={finding.id} finding={finding} onOpen={onOpen} />
      ))}
      {Array.from({ length: skeletonCount }).map((_, i) => (
        <SkeletonCard key={`skeleton-${i}`} />
      ))}
    </div>
  );
}
