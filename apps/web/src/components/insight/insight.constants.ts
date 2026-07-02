/** Static display metadata for the Insight surface: category/severity/effort/scope
 *  labels and glyphs, plus the helpers that order and project these enums. */
import type { ComponentType } from 'react';

import {
  BookIcon,
  BugIcon,
  ChecksIcon,
  DepsIcon,
  DesignIcon,
  LayersIcon,
  PerfIcon,
  RefactorIcon,
  VerifiedIcon,
} from '@/components/ui';
import type {
  AnalysisScope,
  FindingCategory,
  FindingEffort,
  FindingSeverity,
  InsightRun,
} from '@/lib/bridge';

import type { RunStatus } from './insight.types';

/** Every category, in display order. */
export const ALL_CATEGORIES: FindingCategory[] = [
  'architecture',
  'bugs',
  'refactor',
  'performance',
  'security',
  'tests',
  'docs',
  'ui-ux',
  'dependencies',
];

interface CategoryMeta {
  label: string;
  icon: ComponentType<{ size?: number }>;
}

/** Per-category label + glyph for tabs and cards. */
export const CATEGORY_META: Record<FindingCategory, CategoryMeta> = {
  architecture: { label: 'Architecture', icon: LayersIcon },
  bugs: { label: 'Bugs', icon: BugIcon },
  refactor: { label: 'Refactor', icon: RefactorIcon },
  performance: { label: 'Performance', icon: PerfIcon },
  security: { label: 'Security', icon: VerifiedIcon },
  tests: { label: 'Tests', icon: ChecksIcon },
  docs: { label: 'Docs', icon: BookIcon },
  'ui-ux': { label: 'UI / UX', icon: DesignIcon },
  dependencies: { label: 'Dependencies', icon: DepsIcon },
};

/** Severity order, highest first (for sorting + the "All" tab). */
export const SEVERITY_ORDER: FindingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

/** A numeric rank for a severity (higher = more severe), for descending sorts. */
export function severityRankValue(s: FindingSeverity): number {
  return SEVERITY_ORDER.length - SEVERITY_ORDER.indexOf(s);
}

interface SeverityMeta {
  label: string;
  /** Tailwind text tone for the badge. */
  tone: string;
  /** Tailwind bg/border tone for the badge chip. */
  chip: string;
}

/** Per-severity label + Tailwind tones for badges and chips. */
export const SEVERITY_META: Record<FindingSeverity, SeverityMeta> = {
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

/** Per-effort display label. */
export const EFFORT_META: Record<FindingEffort, { label: string }> = {
  trivial: { label: 'Trivial' },
  small: { label: 'Small' },
  medium: { label: 'Medium' },
  large: { label: 'Large' },
};

/** Per-scope label + hint for the scope selector. */
export const SCOPE_META: Record<AnalysisScope, { label: string; hint: string }> = {
  repo: { label: 'Whole repo', hint: 'Analyze the entire codebase' },
  diff: { label: 'Changes', hint: 'Only files changed since the last commit' },
};

/** Map a persisted run's status string to the view's union. */
export function runStatusOf(run: InsightRun | null): RunStatus {
  if (run === null) return 'idle';
  if (run.status === 'running') return 'running';
  if (run.status === 'failed') return 'failed';
  return 'completed';
}
