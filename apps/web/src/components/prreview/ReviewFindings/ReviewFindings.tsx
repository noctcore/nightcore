/** The PR Review results grid: findings bucketed into per-severity COLLAPSIBLE
 *  groups (critical/high open by default; medium/low/info collapsed), each with a
 *  tri-state group checkbox that sweeps its open findings. A summary bar and a
 *  quick-select row (Critical + High · All · None) sit atop the grid; each card
 *  carries a selection {@link Checkbox} whose checked findings compose the posted
 *  GitHub review, and a corroboration chip when other lenses agree. Cards use the
 *  shared {@link DetailCard} / {@link DetailCardGrid} chrome (group headers +
 *  affordances each get their own full-width virtualized row via
 *  {@link GridFullRow}). */
import type { ReactNode } from 'react';

import { CheckIcon, DetailCardGrid, GridFullRow, VerifiedIcon } from '@/components/ui';
import type { Severity } from '@/lib/severity';

import { SEVERITY_META } from '../prreview.constants';
import { ReviewCard } from './ReviewFindingRow';
import { useReviewFindings } from './ReviewFindings.hooks';
import type { ReviewFindingsProps } from './ReviewFindings.types';
import { SeverityGroupHeader } from './ReviewFindingsGroup';

/** Shared chrome for the small quick-select buttons. */
const QUICK_BTN =
  'rounded-[8px] border border-border bg-white/[0.02] px-2.5 py-1 font-mono text-2xs font-medium text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/** The severity summary strip: '2 Critical · 3 High · …' in each severity's tone,
 *  plus an sr-only live region announcing the selected/open tally. Counts OPEN
 *  findings only (the actionable set). */
function FindingsSummary({
  summary,
  openCount,
  selectedCount,
}: {
  summary: { severity: Severity; count: number }[];
  openCount: number;
  selectedCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {summary.map(({ severity, count }, i) => {
        const meta = SEVERITY_META[severity];
        return (
          <span key={severity} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
            )}
            <span className={`font-mono text-2xs font-semibold ${meta.tone}`}>
              {count}
            </span>
            <span className="text-2xs text-muted-foreground">{meta.label}</span>
          </span>
        );
      })}
      {/* Selection tally as a polite live region: quick-select + group toggles
          change it without moving focus, so SR users hear the new count. */}
      <span role="status" aria-live="polite" className="sr-only">
        {selectedCount} of {openCount} findings selected
      </span>
    </div>
  );
}

/** The quick-select presets — each operates on OPEN findings only (replace). */
function QuickSelectRow({
  importantCount,
  selectedCount,
  onSelectImportant,
  onSelectAll,
  onSelectNone,
}: {
  importantCount: number;
  selectedCount: number;
  onSelectImportant: () => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
        Select
      </span>
      <button
        type="button"
        onClick={onSelectImportant}
        disabled={importantCount === 0}
        className={QUICK_BTN}
      >
        Critical + High
      </button>
      <button type="button" onClick={onSelectAll} className={QUICK_BTN}>
        All
      </button>
      <button
        type="button"
        onClick={onSelectNone}
        disabled={selectedCount === 0}
        className={QUICK_BTN}
      >
        None
      </button>
    </div>
  );
}

/** The celebratory clean state: a completed run that surfaced nothing. A positive
 *  (success-toned) empty state rather than the neutral "no findings" line. */
function CleanEmptyState({ message }: { message: string }) {
  return (
    <div
      className="flex flex-col items-center gap-2.5 rounded-[14px] border border-success/25 bg-success/[0.05] px-6 py-12 text-center"
      style={{ animation: 'nc-rise var(--nc-motion-base) var(--nc-ease-out-quint)' }}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-success/[0.12] text-success">
        <VerifiedIcon size={24} />
      </span>
      <p className="text-sm-flat font-semibold text-success">No findings</p>
      <p className="max-w-[420px] text-xs-plus text-muted-foreground">{message}</p>
    </div>
  );
}

/** The "everything triaged" banner: shown atop a grid whose every finding has
 *  been converted to a task or dismissed (nothing left open to act on). */
function AllTriagedBanner() {
  return (
    <div
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-nc border border-success/25 bg-success/[0.06] px-4 py-3"
      style={{ animation: 'nc-rise var(--nc-motion-base) var(--nc-ease-out-quint)' }}
    >
      <CheckIcon size={15} className="shrink-0 text-success" />
      <span className="text-xs-plus font-semibold text-success">All findings triaged</span>
      <span className="text-xs-flat text-muted-foreground">
        Every finding has been converted to a task or dismissed.
      </span>
    </div>
  );
}

/** The results grid: a summary bar + quick-select row, then per-severity
 *  collapsible groups of cards (highest severity first). Falls back to the empty
 *  message when there is nothing to show. The grid renders only in the section's
 *  RESULTS mode (never mid-run), so it carries no streaming skeletons. */
export function ReviewFindings({
  findings,
  emptyMessage,
  emptyVariant = 'neutral',
  selection,
  onToggleSelect,
  onSelectionChange,
  onOpen,
  recurringFingerprints,
}: ReviewFindingsProps) {
  const {
    groups,
    summary,
    openCount,
    selectedOpenCount,
    importantCount,
    toggleExpand,
    onSelectImportant,
    onSelectAll,
    onSelectNone,
    onToggleGroup,
  } = useReviewFindings({ findings, selection, onSelectionChange });

  // Celebratory clean state: a completed run that surfaced nothing gets a
  // positive success-toned empty state, not the neutral "no findings" line.
  if (findings.length === 0 && emptyVariant === 'clean') {
    return <CleanEmptyState message={emptyMessage} />;
  }

  const children: ReactNode[] = [];

  // Summary + quick-select only when there is something to act on; once every
  // finding is converted/dismissed (nothing open) the grid is fully triaged, so
  // a positive "all triaged" banner replaces the triage row atop the dimmed cards.
  if (openCount > 0) {
    children.push(
      <GridFullRow key="summary">
        <FindingsSummary
          summary={summary}
          openCount={openCount}
          selectedCount={selectedOpenCount}
        />
      </GridFullRow>,
      <GridFullRow key="quick-select">
        <QuickSelectRow
          importantCount={importantCount}
          selectedCount={selectedOpenCount}
          onSelectImportant={onSelectImportant}
          onSelectAll={onSelectAll}
          onSelectNone={onSelectNone}
        />
      </GridFullRow>,
    );
  } else if (findings.length > 0) {
    children.push(
      <GridFullRow key="all-triaged">
        <AllTriagedBanner />
      </GridFullRow>,
    );
  }

  for (const group of groups) {
    children.push(
      <GridFullRow key={`section-${group.severity}`}>
        <SeverityGroupHeader
          group={group}
          onToggleExpand={() => toggleExpand(group.severity)}
          onToggleGroup={() => onToggleGroup(group.severity)}
        />
      </GridFullRow>,
    );
    if (!group.expanded) continue;
    for (const finding of group.findings) {
      children.push(
        <ReviewCard
          key={finding.id}
          finding={finding}
          selected={selection.has(finding.id)}
          recurring={recurringFingerprints?.has(finding.fingerprint) ?? false}
          onToggleSelect={onToggleSelect}
          onOpen={onOpen}
        />,
      );
    }
  }

  return (
    <DetailCardGrid
      isEmpty={findings.length === 0}
      emptyMessage={emptyMessage}
      skeletonCount={0}
      scrollsWithPage
    >
      {/* `children` is a flat list of already-keyed affordances + section
          headers + cards — headers/banners are `GridFullRow`-wrapped so the
          virtualizer gives each its own full-width row instead of packing it
          beside cards. */}
      {children}
    </DetailCardGrid>
  );
}
