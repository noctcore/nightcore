import { Card } from '@/components/ui';

import {
  DIMENSION_META,
  GRADE_META,
  type GradeTrend,
  type GradeTrendDirection,
} from '../scorecard.constants';
import type { DimensionGridProps, DimensionRow } from './DimensionGrid.types';

/** Per-direction glyph + tone + spoken label for the grade-trend chip (T8). */
const TREND_META: Record<GradeTrendDirection, { glyph: string; tone: string; verb: string }> = {
  up: { glyph: '▲', tone: 'text-success', verb: 'improved' },
  down: { glyph: '▼', tone: 'text-destructive', verb: 'regressed' },
  flat: { glyph: '→', tone: 'text-muted-foreground', verb: 'unchanged' },
};

/** A compact chip showing how this dimension's grade moved vs the previous run,
 *  with the recent-grades trail in its title ("grade over recent runs"). Renders
 *  nothing without a prior run to compare against. */
function GradeTrendChip({ trend }: { trend: GradeTrend }) {
  const meta = TREND_META[trend.direction];
  const text = trend.direction === 'flat' ? 'no change' : `from ${trend.previousGrade}`;
  const label = `Grade ${meta.verb} vs previous run (was ${trend.previousGrade})`;
  return (
    <span
      aria-label={label}
      title={`${label}. Recent: ${trend.history.join(' → ')}`}
      className={`inline-flex items-center gap-1 rounded-md border border-border bg-white/[0.02] px-1.5 py-0.5 font-mono text-[10px] font-semibold ${meta.tone}`}
    >
      <span aria-hidden>{meta.glyph}</span>
      <span>{text}</span>
    </span>
  );
}

/** The big A–F grade chip (or a live/ungraded placeholder) shown at the head of a
 *  row. The grade is the headline of the whole feature, so it is the loudest mark. */
function GradeChip({ row }: { row: DimensionRow }) {
  if (row.reading !== null) {
    const meta = GRADE_META[row.reading.grade];
    return (
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border font-mono text-[22px] font-bold leading-none ${meta.chip} ${meta.tone}`}
      >
        {meta.label}
      </span>
    );
  }
  if (row.state === 'running') {
    return (
      <span
        aria-label="grading"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-primary/40 bg-primary/[0.06]"
      >
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-primary" />
      </span>
    );
  }
  // Pending or errored-without-reading: a quiet placeholder.
  return (
    <span
      aria-label={row.state === 'error' ? 'grading failed' : 'pending'}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-border bg-white/[0.02] font-mono text-[20px] font-bold leading-none ${
        row.state === 'error' ? 'text-destructive' : 'text-muted-foreground/50'
      }`}
    >
      {row.state === 'error' ? '!' : '–'}
    </span>
  );
}

/** One dimension row: grade chip, dimension label + glyph, the reading's title and
 *  a truncated summary, plus a "task" badge when already hardened. Clickable only
 *  when graded. */
function DimensionRowCard({
  row,
  onOpen,
}: {
  row: DimensionRow;
  onOpen: DimensionGridProps['onOpen'];
}) {
  const Meta = DIMENSION_META[row.dimension];
  const Icon = Meta.icon;
  const reading = row.reading;
  const clickable = reading !== null;

  const body = (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-muted-foreground" />
        <span className="text-[13.5px] font-semibold text-foreground">
          {Meta.label}
        </span>
        {reading !== null && row.trend !== null && <GradeTrendChip trend={row.trend} />}
        {reading?.status === 'converted' && (
          <span className="rounded-md bg-success/[0.12] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-success">
            task
          </span>
        )}
      </div>
      {reading !== null ? (
        <>
          <span className="truncate text-[12.5px] text-foreground/90">
            {reading.title}
          </span>
          <p className="line-clamp-1 text-[11.5px] leading-relaxed text-muted-foreground">
            {reading.summary}
          </p>
        </>
      ) : (
        <span className="text-[11.5px] text-muted-foreground">
          {row.state === 'running'
            ? 'Grading…'
            : row.state === 'error'
              ? 'Grading failed'
              : 'Queued'}
        </span>
      )}
    </div>
  );

  if (!clickable) {
    return (
      <div className="flex items-center gap-3.5 rounded-[10px] border border-border bg-white/[0.02] p-3.5">
        <GradeChip row={row} />
        {body}
      </div>
    );
  }

  return (
    <Card
      onClick={() => onOpen(reading)}
      className="flex items-center gap-3.5 p-3.5 text-left"
    >
      <GradeChip row={row} />
      {body}
    </Card>
  );
}

/** The dimension grid (the Scorecard's `FindingGrid` analogue): one row per
 *  dimension, each fronted by its big A–F grade chip. Worst grades are sorted
 *  upstream so the weakest dimensions surface first. */
export function DimensionGrid({ rows, emptyMessage, onOpen }: DimensionGridProps) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-6 py-5">
      {rows.map((row) => (
        <DimensionRowCard key={row.dimension} row={row} onOpen={onOpen} />
      ))}
    </div>
  );
}
