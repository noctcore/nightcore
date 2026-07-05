/** The PR Review results grid: findings bucketed into per-severity COLLAPSIBLE
 *  groups (critical/high open by default; medium/low/info collapsed), each with a
 *  tri-state group checkbox that sweeps its open findings. A summary bar and a
 *  quick-select row (Critical + High · All · None) sit atop the grid; each card
 *  carries a selection {@link Checkbox} whose checked findings compose the posted
 *  GitHub review, and a corroboration chip when other lenses agree. Cards use the
 *  shared {@link DetailCard} / {@link DetailCardGrid} chrome (group headers +
 *  affordances span the grid via `col-span-full`). */
import type { ReactNode } from 'react';

import {
  Checkbox,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DetailCard,
  DetailCardGrid,
  VerifiedIcon,
} from '@/components/ui';
import type { Severity } from '@/lib/severity';

import { LENS_META, SEVERITY_META } from '../prreview.constants';
import type { ReviewFindingView } from '../prreview.types';
import type { GroupTriState, SeverityGroupView } from './ReviewFindings.hooks';
import { useReviewFindings } from './ReviewFindings.hooks';
import type { ReviewFindingsProps } from './ReviewFindings.types';

/** Format a review finding's grounded location as `file:line` (or `file` when the
 *  finding is not line-localizable). */
function formatReviewLocation(finding: ReviewFindingView): string {
  return finding.line !== null ? `${finding.file}:${finding.line}` : finding.file;
}

/** Shared chrome for the small quick-select buttons. */
const QUICK_BTN =
  'rounded-[8px] border border-border bg-white/[0.02] px-2.5 py-1 font-mono text-[11px] font-medium text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring';

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
    <div className="col-span-full flex flex-wrap items-center gap-x-2 gap-y-1">
      {summary.map(({ severity, count }, i) => {
        const meta = SEVERITY_META[severity];
        return (
          <span key={severity} className="flex items-center gap-1.5">
            {i > 0 && (
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
            )}
            <span className={`font-mono text-[11px] font-semibold ${meta.tone}`}>
              {count}
            </span>
            <span className="text-[11px] text-muted-foreground">{meta.label}</span>
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
    <div className="col-span-full flex flex-wrap items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
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

/** The tri-state box glyph: filled check (all), a dash (some), or an empty box. */
function GroupCheckboxBox({ triState }: { triState: GroupTriState }) {
  const filled = triState !== 'unchecked';
  return (
    <span
      aria-hidden
      className={`flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        filled
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-white/[0.02]'
      }`}
    >
      {triState === 'checked' && <CheckIcon size={12} />}
      {triState === 'indeterminate' && (
        <span className="h-[2px] w-[9px] rounded-full bg-primary-foreground" />
      )}
    </span>
  );
}

/** A collapsible severity group header: a tri-state checkbox (sweeps the group's
 *  open findings) beside a labelled collapse toggle carrying the group count. The
 *  two controls are siblings (never nested), so both stay keyboard-reachable. */
function SeverityGroupHeader({
  group,
  onToggleExpand,
  onToggleGroup,
}: {
  group: SeverityGroupView;
  onToggleExpand: () => void;
  onToggleGroup: () => void;
}) {
  const meta = SEVERITY_META[group.severity];
  const Chevron = group.expanded ? ChevronDownIcon : ChevronRightIcon;
  const ariaChecked: boolean | 'mixed' =
    group.triState === 'checked'
      ? true
      : group.triState === 'indeterminate'
        ? 'mixed'
        : false;

  return (
    <div className="col-span-full flex items-center gap-2.5 pt-3 first:pt-0">
      <button
        type="button"
        role="checkbox"
        aria-checked={ariaChecked}
        aria-label={`Select all open ${meta.label} findings`}
        disabled={group.openCount === 0}
        onClick={onToggleGroup}
        className="rounded-[6px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
      >
        <GroupCheckboxBox triState={group.triState} />
      </button>
      <button
        type="button"
        aria-expanded={group.expanded}
        onClick={onToggleExpand}
        className="flex flex-1 items-center gap-2 rounded-[6px] py-0.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Chevron size={13} className="shrink-0 text-muted-foreground" />
        <span
          className={`font-mono text-[11px] font-semibold uppercase tracking-[0.08em] ${meta.tone}`}
        >
          {meta.label}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {group.findings.length}
        </span>
      </button>
    </div>
  );
}

/** One finding card: the selection checkbox above the shared card chrome
 *  (severity + lens badges, corroboration chip, grounded file:line, inert body). */
function ReviewCard({
  finding,
  selected,
  recurring,
  onToggleSelect,
  onOpen,
}: {
  finding: ReviewFindingView;
  selected: boolean;
  recurring: boolean;
  onToggleSelect: (findingId: string) => void;
  onOpen: (finding: ReviewFindingView) => void;
}) {
  const sev = SEVERITY_META[finding.severity];
  const Meta = LENS_META[finding.lens];
  const Icon = Meta.icon;
  const dimmed = finding.status !== 'open';
  const corroborated = finding.corroboratedBy.length > 0;

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
            {/* Corroboration: other lenses independently surfaced this issue —
                a compact "also: security, tests" chip (fuller labels on hover). */}
            {corroborated && (
              <span
                className="inline-flex items-center rounded-md border border-primary/25 bg-primary/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                title={`Also surfaced by: ${finding.corroboratedBy
                  .map((l) => LENS_META[l].label)
                  .join(', ')}`}
              >
                also: {finding.corroboratedBy.join(', ')}
              </span>
            )}
            {/* Carried over from the previous review (follow-up comparison) —
                subtle, so it never competes with the severity/lens badges. */}
            {recurring && finding.status === 'open' && (
              <span className="inline-flex items-center rounded-md border border-warning/30 bg-warning/[0.08] px-1.5 py-0.5 font-mono text-[10px] font-medium text-warning/90">
                still open
              </span>
            )}
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

/** The celebratory clean state: a completed run that surfaced nothing. A positive
 *  (success-toned) empty state rather than the neutral "no findings" line. */
function CleanEmptyState({ message }: { message: string }) {
  return (
    <div
      className="flex flex-col items-center gap-2.5 rounded-[14px] border border-success/25 bg-success/[0.05] px-6 py-12 text-center"
      style={{ animation: 'nc-rise .22s cubic-bezier(.22,1,.36,1)' }}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-success/[0.12] text-success">
        <VerifiedIcon size={24} />
      </span>
      <p className="text-[14px] font-semibold text-success">No findings</p>
      <p className="max-w-[420px] text-[12.5px] text-muted-foreground">{message}</p>
    </div>
  );
}

/** The "everything triaged" banner: shown atop a grid whose every finding has
 *  been converted to a task or dismissed (nothing left open to act on). */
function AllTriagedBanner() {
  return (
    <div
      className="col-span-full flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[10px] border border-success/25 bg-success/[0.06] px-4 py-3"
      style={{ animation: 'nc-rise .2s cubic-bezier(.22,1,.36,1)' }}
    >
      <CheckIcon size={15} className="shrink-0 text-success" />
      <span className="text-[12.5px] font-semibold text-success">All findings triaged</span>
      <span className="text-[12px] text-muted-foreground">
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
      <FindingsSummary
        key="summary"
        summary={summary}
        openCount={openCount}
        selectedCount={selectedOpenCount}
      />,
      <QuickSelectRow
        key="quick-select"
        importantCount={importantCount}
        selectedCount={selectedOpenCount}
        onSelectImportant={onSelectImportant}
        onSelectAll={onSelectAll}
        onSelectNone={onSelectNone}
      />,
    );
  } else if (findings.length > 0) {
    children.push(<AllTriagedBanner key="all-triaged" />);
  }

  for (const group of groups) {
    children.push(
      <SeverityGroupHeader
        key={`section-${group.severity}`}
        group={group}
        onToggleExpand={() => toggleExpand(group.severity)}
        onToggleGroup={() => onToggleGroup(group.severity)}
      />,
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
    >
      {/* `children` is a flat list of already-keyed affordances + section
          headers + cards (headers span the grid via `col-span-full`). */}
      {children}
    </DetailCardGrid>
  );
}
