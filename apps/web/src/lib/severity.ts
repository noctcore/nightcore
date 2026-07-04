/** The shared severity scale used by every grounded-finding surface (Insight,
 *  Harness, PR-review). The Insight `FindingSeverity` and PR-review
 *  `ReviewSeverity` contract enums are the same five members, so the ordering,
 *  ranking, and badge palette are declared once here rather than re-cloned per
 *  feature — `no-cross-feature-imports` forbids a sibling feature from reaching
 *  into another's constants, so `lib/` is the one import-legal shared home. */

/** The five severity levels, structurally identical to the `FindingSeverity` and
 *  `ReviewSeverity` contract enums. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Severity order, highest first (for sorting + the "All"/section headers). */
export const SEVERITY_ORDER: Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

/** A numeric rank for a severity (higher = more severe), for descending sorts. */
export function severityRankValue(s: Severity): number {
  return SEVERITY_ORDER.length - SEVERITY_ORDER.indexOf(s);
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
