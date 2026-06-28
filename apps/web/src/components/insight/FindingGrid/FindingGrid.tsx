/** The Insight finding grid plus its module-local card and skeleton. */
import { Card, Skeleton } from '@/components/ui';
import {
  CATEGORY_META,
  EFFORT_META,
  SEVERITY_META,
} from '../insight.constants';
import type { InsightFinding } from '../insight.types';
import type { FindingGridProps } from './FindingGrid.types';

function locationLabel(finding: InsightFinding): string | null {
  const loc = finding.location;
  if (loc === null) return null;
  if (loc.startLine !== null) {
    const range =
      loc.endLine !== null && loc.endLine !== loc.startLine
        ? `${loc.startLine}-${loc.endLine}`
        : String(loc.startLine);
    return `${loc.file}:${range}`;
  }
  return loc.file;
}

/** One finding card: severity/effort badges, category glyph, title, grounded
 *  file:line, and a truncated description. Clickable → the detail panel. Inlined
 *  here as a module-local since the grid is its only consumer. */
function FindingCard({
  finding,
  onOpen,
}: {
  finding: InsightFinding;
  onOpen: (finding: InsightFinding) => void;
}) {
  const sev = SEVERITY_META[finding.severity];
  const Meta = CATEGORY_META[finding.category];
  const Icon = Meta.icon;
  const loc = locationLabel(finding);
  const dimmed = finding.status !== 'open';

  return (
    <Card
      onClick={() => onOpen(finding)}
      title={dimmed ? (finding.status === 'converted' ? 'Converted to task' : 'Dismissed') : undefined}
      className="flex flex-col gap-2 p-3.5 text-left"
    >
      <div className="flex items-center gap-2">
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

/** A skeleton finding card that preserves the card layout while a category pass is
 *  still running (streaming UX). */
function SkeletonCard() {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-white/[0.02] p-3.5">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-14" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="ml-auto h-4 w-10" />
      </div>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
    </div>
  );
}

/** The finding grid. Renders real cards, then any streaming skeletons; falls back
 *  to an empty message when there is nothing to show and nothing in flight. */
export function FindingGrid({
  findings,
  skeletonCount,
  emptyMessage,
  onOpen,
}: FindingGridProps) {
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
    <div className="grid flex-1 grid-cols-1 content-start gap-3 overflow-y-auto px-6 py-5 sm:grid-cols-2 xl:grid-cols-3">
      {findings.map((finding) => (
        <FindingCard key={finding.id} finding={finding} onOpen={onOpen} />
      ))}
      {Array.from({ length: skeletonCount }).map((_, i) => (
        <SkeletonCard key={`skeleton-${i}`} />
      ))}
    </div>
  );
}
