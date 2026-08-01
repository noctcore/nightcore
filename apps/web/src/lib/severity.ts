/** The web's presentation layer over the ONE contract severity scale, used by every
 *  grounded-finding surface (Insight, Harness, PR-review). The scale's MEMBERS are not
 *  declared here — they come from `@nightcore/contracts` (issue #178, which retired the
 *  hand-written union this file used to carry). What IS declared here is everything the
 *  contract has no opinion about: display order, rank, and the badge palette. They live
 *  in `lib/` rather than in a feature because `no-cross-feature-imports` forbids a
 *  sibling feature from reaching into another's constants, so `lib/` is the one
 *  import-legal shared home. */
import { type Severity, SeveritySchema } from '@nightcore/contracts';

export type { Severity };

/** Severity order, highest first (for sorting + the "All"/section headers) —
 *  DERIVED by reversing the contract's low→high declaration order rather than
 *  restated, so a new level added to the contract cannot silently miss this list.
 *  (`SEVERITY_META` below is a `Record<Severity, …>`, so the compiler forces the
 *  palette to grow with it too.) */
export const SEVERITY_ORDER: readonly Severity[] = [
  ...SeveritySchema.options,
].reverse();

/** A numeric rank for a severity (higher = more severe), for descending sorts. */
export function severityRankValue(s: Severity): number {
  return SEVERITY_ORDER.length - SEVERITY_ORDER.indexOf(s);
}

/** Order grounded findings for display: open before resolved (dismissed /
 *  converted), then severity high→low. This exact comparator was cloned by
 *  every scan family's results grid (Insight / Harness / PR-Review). Returns a
 *  new array; the input is untouched. */
export function sortBySeverityThenStatus<
  T extends { status: string; severity: Severity },
>(items: readonly T[]): T[] {
  const statusRank = (i: T) => (i.status === 'open' ? 0 : 1);
  return [...items].sort((a, b) => {
    const s = statusRank(a) - statusRank(b);
    if (s !== 0) return s;
    return severityRankValue(b.severity) - severityRankValue(a.severity);
  });
}

export interface SeverityMeta {
  label: string;
  /** Tailwind text tone for the badge. */
  tone: string;
  /** Tailwind bg/border tone for the badge chip. */
  chip: string;
}

/** Per-severity label + Tailwind tones for badges, chips, and section headers. */
export const SEVERITY_META: Record<Severity, SeverityMeta> = {
  critical: {
    label: 'Critical',
    tone: 'text-destructive',
    chip: 'bg-destructive/[0.12] border-destructive/40',
  },
  high: {
    label: 'High',
    tone: 'text-warning',
    chip: 'bg-warning/[0.12] border-warning/40',
  },
  medium: {
    label: 'Medium',
    tone: 'text-primary',
    chip: 'bg-primary/[0.1] border-primary/40',
  },
  low: {
    label: 'Low',
    tone: 'text-muted-foreground',
    chip: 'bg-white/[0.04] border-border',
  },
  info: {
    label: 'Info',
    tone: 'text-muted-foreground',
    chip: 'bg-white/[0.04] border-border',
  },
};
