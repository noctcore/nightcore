/** The ReviewFindings triage state: which severity groups are expanded, the
 *  per-severity grouping + tri-state selection math, and the bulk selection ops
 *  (quick-select presets + group toggles). All selection writes REPLACE the
 *  parent-owned set via `onSelectionChange`; the component stays a thin shell.
 *
 *  Every bulk op operates on OPEN findings only — dismissed can't be posted and
 *  converted are already tracked as tasks, so neither joins a preset/group sweep
 *  (they still render as dimmed cards with an individual checkbox). */
import { useCallback, useMemo, useState } from 'react';

import type { Severity } from '@/lib/severity';

import { SEVERITY_ORDER } from '../prreview.constants';
import type { ReviewFindingView } from '../prreview.types';

/** A group checkbox reflects three states: none / some / all of the group's open
 *  findings selected (rendered as aria-checked false / mixed / true). */
export type GroupTriState = 'unchecked' | 'indeterminate' | 'checked';

/** One rendered severity group: every finding in the bucket (open first, then
 *  dimmed converted/dismissed), plus the open-finding tallies the header shows. */
export interface SeverityGroupView {
  severity: Severity;
  /** All findings in this severity bucket, in the incoming (open-first) order. */
  findings: ReviewFindingView[];
  /** Open findings only — the ones the group checkbox toggles. */
  openCount: number;
  /** How many of those open findings are currently selected. */
  selectedOpenCount: number;
  triState: GroupTriState;
  expanded: boolean;
}

/** One summary-bar entry: a severity with a positive open-finding count. */
export interface SeveritySummaryEntry {
  severity: Severity;
  count: number;
}

export interface ReviewFindingsModel {
  /** Non-empty severity groups, highest severity first. */
  groups: SeverityGroupView[];
  /** Open-finding counts by severity (only positive ones) for the summary bar. */
  summary: SeveritySummaryEntry[];
  /** Total open findings across all groups (drives the summary/quick-select gate). */
  openCount: number;
  /** Selected open findings across all groups (the live-region count). */
  selectedOpenCount: number;
  /** Open critical + high findings — the "Critical + High" preset's reach. */
  importantCount: number;
  /** Expand/collapse one severity group. */
  toggleExpand: (severity: Severity) => void;
  /** Select exactly the open critical + high findings (replace). */
  onSelectImportant: () => void;
  /** Select every open finding (replace). */
  onSelectAll: () => void;
  /** Clear the whole selection. */
  onSelectNone: () => void;
  /** Tri-state toggle one group's open findings, preserving other groups. */
  onToggleGroup: (severity: Severity) => void;
}

export interface UseReviewFindingsArgs {
  findings: ReviewFindingView[];
  selection: ReadonlySet<string>;
  /** Replace the whole selection (the parent stores it). */
  onSelectionChange: (next: ReadonlySet<string>) => void;
}

/** Critical + High are the "important" tier the top preset targets. */
function isImportant(f: ReviewFindingView): boolean {
  return f.severity === 'critical' || f.severity === 'high';
}

/** Resolve the ReviewFindings triage model: grouping, tri-state, and bulk ops. */
export function useReviewFindings({
  findings,
  selection,
  onSelectionChange,
}: UseReviewFindingsArgs): ReviewFindingsModel {
  // Critical + High open by default; Medium/Low/Info collapsed (the triage
  // default — the loud findings are visible, the long tail is one click away).
  const [expanded, setExpanded] = useState<ReadonlySet<Severity>>(
    () => new Set<Severity>(['critical', 'high']),
  );
  const toggleExpand = useCallback((severity: Severity) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(severity)) next.delete(severity);
      else next.add(severity);
      return next;
    });
  }, []);

  const openFindings = useMemo(
    () => findings.filter((f) => f.status === 'open'),
    [findings],
  );

  const groups = useMemo<SeverityGroupView[]>(() => {
    const out: SeverityGroupView[] = [];
    for (const severity of SEVERITY_ORDER) {
      const items = findings.filter((f) => f.severity === severity);
      if (items.length === 0) continue;
      const groupOpen = items.filter((f) => f.status === 'open');
      const selectedOpenCount = groupOpen.filter((f) =>
        selection.has(f.id),
      ).length;
      const triState: GroupTriState =
        groupOpen.length === 0 || selectedOpenCount === 0
          ? 'unchecked'
          : selectedOpenCount === groupOpen.length
            ? 'checked'
            : 'indeterminate';
      out.push({
        severity,
        findings: items,
        openCount: groupOpen.length,
        selectedOpenCount,
        triState,
        expanded: expanded.has(severity),
      });
    }
    return out;
  }, [findings, selection, expanded]);

  const summary = useMemo<SeveritySummaryEntry[]>(
    () =>
      SEVERITY_ORDER.map((severity) => ({
        severity,
        count: openFindings.filter((f) => f.severity === severity).length,
      })).filter((entry) => entry.count > 0),
    [openFindings],
  );

  const selectedOpenCount = useMemo(
    () => openFindings.filter((f) => selection.has(f.id)).length,
    [openFindings, selection],
  );
  const importantCount = useMemo(
    () => openFindings.filter(isImportant).length,
    [openFindings],
  );

  const onSelectAll = useCallback(
    () => onSelectionChange(new Set(openFindings.map((f) => f.id))),
    [openFindings, onSelectionChange],
  );
  const onSelectImportant = useCallback(
    () =>
      onSelectionChange(
        new Set(openFindings.filter(isImportant).map((f) => f.id)),
      ),
    [openFindings, onSelectionChange],
  );
  const onSelectNone = useCallback(
    () => onSelectionChange(new Set<string>()),
    [onSelectionChange],
  );
  const onToggleGroup = useCallback(
    (severity: Severity) => {
      const groupOpen = openFindings.filter((f) => f.severity === severity);
      // Fully selected → deselect the group; otherwise select all of its open
      // findings (indeterminate + unchecked both resolve to "select all").
      const allSelected =
        groupOpen.length > 0 && groupOpen.every((f) => selection.has(f.id));
      const next = new Set(selection);
      for (const f of groupOpen) {
        if (allSelected) next.delete(f.id);
        else next.add(f.id);
      }
      onSelectionChange(next);
    },
    [openFindings, selection, onSelectionChange],
  );

  return {
    groups,
    summary,
    openCount: openFindings.length,
    selectedOpenCount,
    importantCount,
    toggleExpand,
    onSelectImportant,
    onSelectAll,
    onSelectNone,
    onToggleGroup,
  };
}
